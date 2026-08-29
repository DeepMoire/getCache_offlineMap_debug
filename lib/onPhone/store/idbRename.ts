/** ⚠️ Must NOT create the DB if it doesn't exist — `indexedDB.open(name)` with no version silently creates an empty, store-less DB (the bug that poisoned the renamed boxes). */
async function dbExists(name: string): Promise<boolean> {
	try {
		if (typeof indexedDB.databases === "function") {
			const dbs = await indexedDB.databases();
			return dbs.some((d) => d.name === name);
		}
	} catch {
	}
	// No indexedDB.databases() support (older Firefox) — bias to true so we never accidentally create a store-less DB.
	return true;
}

/** Does a database of this name exist AND hold at least one record? */
async function dbHasData(name: string, store: string): Promise<boolean> {
	if (!(await dbExists(name))) return false;
	return new Promise((resolve) => {
		const req = indexedDB.open(name);
		req.onsuccess = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(store)) {
				db.close();
				resolve(false);
				return;
			}
			const countReq = db
				.transaction(store, "readonly")
				.objectStore(store)
				.count();
			countReq.onsuccess = () => {
				db.close();
				resolve(countReq.result > 0);
			};
			countReq.onerror = () => {
				db.close();
				resolve(false);
			};
		};
		req.onerror = () => resolve(false);
		// A blocked open (another tab holds it) — don't hang; treat as unknown.
		req.onblocked = () => resolve(false);
	});
}

/** Read every [key, value] pair out of a single-store, explicitly-keyed DB. */
async function readAll(
	name: string,
	store: string,
): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
	if (!(await dbExists(name))) return [];
	return new Promise((resolve) => {
		const req = indexedDB.open(name);
		req.onsuccess = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(store)) {
				db.close();
				resolve([]);
				return;
			}
			const out: Array<{ key: IDBValidKey; value: unknown }> = [];
			const cursorReq = db
				.transaction(store, "readonly")
				.objectStore(store)
				.openCursor();
			cursorReq.onsuccess = () => {
				const cursor = cursorReq.result;
				if (cursor) {
					out.push({ key: cursor.key, value: cursor.value });
					cursor.continue();
				} else {
					db.close();
					resolve(out);
				}
			};
			cursorReq.onerror = () => {
				db.close();
				resolve(out);
			};
		};
		req.onerror = () => resolve([]);
		req.onblocked = () => resolve([]);
	});
}

/** Write [key, value] pairs into a freshly-created single-store DB (version 1). */
async function writeAll(
	name: string,
	store: string,
	rows: Array<{ key: IDBValidKey; value: unknown }>,
): Promise<boolean> {
	return new Promise((resolve) => {
		const req = indexedDB.open(name, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
		};
		req.onsuccess = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(store)) {
				db.close();
				resolve(false);
				return;
			}
			const tx = db.transaction(store, "readwrite");
			const os = tx.objectStore(store);
			for (const { key, value } of rows) os.put(value, key);
			tx.oncomplete = () => {
				db.close();
				resolve(true);
			};
			tx.onerror = () => {
				db.close();
				resolve(false);
			};
		};
		req.onerror = () => resolve(false);
		req.onblocked = () => resolve(false);
	});
}

/** Delete `name` IF it exists but does NOT contain `store` (a poisoned shell). */
async function deleteIfShell(name: string, store: string): Promise<void> {
	if (!(await dbExists(name))) return;
	const isShell = await new Promise<boolean>((resolve) => {
		const req = indexedDB.open(name);
		req.onsuccess = () => {
			const db = req.result;
			const missing = !db.objectStoreNames.contains(store);
			db.close();
			resolve(missing);
		};
		req.onerror = () => resolve(false);
		req.onblocked = () => resolve(false);
	});
	if (!isShell) return;
	await new Promise<void>((resolve) => {
		const del = indexedDB.deleteDatabase(name);
		del.onsuccess = () => {
			console.info(`[idbRename] deleted poisoned shell DB "${name}"`);
			resolve();
		};
		del.onerror = () => resolve();
		del.onblocked = () => resolve();
	});
}

export async function migrateIdbDatabase(
	oldName: string,
	newName: string,
	store: string,
): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	try {
		// Heals a poisoned SHELL (dest DB exists but lacks its store) — left alone it blocks the module from ever creating its store.
		await deleteIfShell(newName, store);

		if (await dbHasData(newName, store)) return;
		if (!(await dbHasData(oldName, store))) return;

		const rows = await readAll(oldName, store);
		if (rows.length === 0) return;
		const ok = await writeAll(newName, store, rows);
		if (ok) {
			console.info(
				`[idbRename] migrated ${rows.length} record(s) ${oldName} → ${newName}`,
			);
		}
	} catch {
		// Best-effort — never throw; a failed migration must not be able to break boot.
	}
}

/** Does any objectStore in this database hold at least one record? */
function anyStoreHasData(db: IDBDatabase): Promise<boolean> {
	const names = Array.from(db.objectStoreNames);
	if (names.length === 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		const tx = db.transaction(names, "readonly");
		let pending = names.length;
		let found = false;
		for (const n of names) {
			const c = tx.objectStore(n).count();
			c.onsuccess = () => {
				if (c.result > 0) found = true;
				if (--pending === 0) resolve(found);
			};
			c.onerror = () => {
				if (--pending === 0) resolve(found);
			};
		}
	});
}

export async function cloneEntireIdbDatabase(
	oldName: string,
	newName: string,
): Promise<void> {
	if (typeof indexedDB === "undefined") return;

	// Open WITHOUT creating — only open a name that already exists, or leave a store-less shell (the bug that broke renamed boxes).
	const openPlain = async (name: string): Promise<IDBDatabase | null> => {
		if (!(await dbExists(name))) return null;
		return new Promise((resolve) => {
			const req = indexedDB.open(name);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		});
	};

	try {
		const dest0 = await openPlain(newName);
		if (dest0) {
			const has = await anyStoreHasData(dest0);
			dest0.close();
			if (has) return;
		}

		const src = await openPlain(oldName);
		if (!src) return;
		const storeNames = Array.from(src.objectStoreNames);
		if (storeNames.length === 0) {
			src.close();
			return;
		}
		if (!(await anyStoreHasData(src))) {
			src.close();
			return;
		}

		type StoreDump = {
			name: string;
			keyPath: string | string[] | null;
			autoIncrement: boolean;
			rows: Array<{ key: IDBValidKey; value: unknown }>;
		};
		const dumps: StoreDump[] = await new Promise((resolve) => {
			const tx = src.transaction(storeNames, "readonly");
			const result: StoreDump[] = [];
			let pending = storeNames.length;
			for (const n of storeNames) {
				const os = tx.objectStore(n);
				const dump: StoreDump = {
					name: n,
					keyPath: os.keyPath as string | string[] | null,
					autoIncrement: os.autoIncrement,
					rows: [],
				};
				result.push(dump);
				const cur = os.openCursor();
				cur.onsuccess = () => {
					const c = cur.result;
					if (c) {
						// Inline keyPath → key travels inside value; out-of-line key → must capture it explicitly.
						dump.rows.push({ key: c.key, value: c.value });
						c.continue();
					} else if (--pending === 0) {
						resolve(result);
					}
				};
				cur.onerror = () => {
					if (--pending === 0) resolve(result);
				};
			}
		});
		src.close();

		const ok = await new Promise<boolean>((resolve) => {
			const req = indexedDB.open(newName, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				for (const d of dumps) {
					if (db.objectStoreNames.contains(d.name)) continue;
					db.createObjectStore(
						d.name,
						d.keyPath != null
							? { keyPath: d.keyPath, autoIncrement: d.autoIncrement }
							: { autoIncrement: d.autoIncrement },
					);
				}
			};
			req.onsuccess = () => {
				const db = req.result;
				const tx = db.transaction(
					dumps.map((d) => d.name),
					"readwrite",
				);
				for (const d of dumps) {
					const os = tx.objectStore(d.name);
					for (const { key, value } of d.rows) {
						// keyPath store → key is inline, must NOT pass a key arg.
						if (d.keyPath != null) os.put(value);
						else os.put(value, key);
					}
				}
				tx.oncomplete = () => {
					db.close();
					resolve(true);
				};
				tx.onerror = () => {
					db.close();
					resolve(false);
				};
			};
			req.onerror = () => resolve(false);
			req.onblocked = () => resolve(false);
		});
		if (ok) {
			const total = dumps.reduce((s, d) => s + d.rows.length, 0);
			console.info(
				`[idbRename] cloned ${total} record(s) across ${dumps.length} store(s) ${oldName} → ${newName}`,
			);
		}
	} catch {
		// Best-effort: never let a clone failure break boot.
	}
}

/** ⛔ Table names are the caller's, not this child's — never hardcode ReTreever-specific names here. */
/** ⚠️ Must run before the persister loads — the schema no longer declares old names, so running late silently drops both tables. */
export interface TableRename {
	/** Old table id in the persister's `t` store. */
	from: string;
	/** New table id. A populated destination always wins. */
	to: string;
	/** Optional per-row FK cell rename applied while moving THIS table. */
	cell?: { from: string; to: string };
}

export async function renameQaTablesInIdb(
	dbName: string,
	renames: TableRename[] = [],
): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	if (renames.length === 0) return;
	try {
		if (!(await dbExists(dbName))) return;
		const db = await new Promise<IDBDatabase | null>((resolve) => {
			const req = indexedDB.open(dbName);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		});
		if (!db) return;
		if (!db.objectStoreNames.contains("t")) {
			db.close();
			return;
		}
		const RENAMES = renames;
		let moved = 0;
		await new Promise<void>((resolve) => {
			const tx = db.transaction("t", "readwrite");
			const os = tx.objectStore("t");
			for (const { from, to, cell } of RENAMES) {
				const get = os.get(from);
				get.onsuccess = () => {
					const rec = get.result as
						| { k: string; v: Record<string, Record<string, unknown>> }
						| undefined;
					if (!rec) return;
					const existing = os.get(to);
					existing.onsuccess = () => {
						// A populated destination record wins (never clobber newer data) — drop the stale old-name record.
						if (!existing.result) {
							const rows = rec.v ?? {};
							if (cell) {
								for (const row of Object.values(rows)) {
									if (row && typeof row === "object" && cell.from in row) {
										(row as Record<string, unknown>)[cell.to] = (
											row as Record<string, unknown>
										)[cell.from];
										delete (row as Record<string, unknown>)[cell.from];
									}
								}
							}
							os.put({ k: to, v: rows });
							moved++;
						}
						os.delete(from);
					};
				};
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		});
		db.close();
		if (moved) {
			console.info(
				`[idbRename] renamed ${moved} table record(s)`,
			);
		}
	} catch {
		// Best-effort: never let the rename break boot — old records stay for retry.
	}
}
