/** keyedIdbStore.ts — the IndexedDB wrapper for the offline boxes (one object store, no keyPath, explicit string keys). ⚠️ SHELL HEAL: a DB that exists but lacks its store throws "object store not found" forever until deleted + recreated on first open. */

import {
	currentDbName,
	registerOfflineDbReset,
} from "../../shared/sandboxDbNames";

export interface KeyedIdbStore<T> {
	get(key: string): Promise<T | undefined>;
	put(key: string, value: T): Promise<void>;
	delete(key: string): Promise<void>;
	/** Every stored key, as strings (keys are always explicit strings here). */
	keys(): Promise<string[]>;
	/** Every stored value. ⚠️ Deserializes the WHOLE store in one main-thread task — use getAllProjected for a big store. */
	getAll(): Promise<T[]>;
	/** Every stored value, cursor-streamed and reduced via project(value) so full records never all exist at once. */
	getAllProjected<P>(project: (value: T) => P): Promise<P[]>;
}

export function makeKeyedIdbStore<T>(opts: {
	dbName: string;
	storeName: string;
	version?: number;
}): KeyedIdbStore<T> {
	const { dbName, storeName, version = 1 } = opts;

	let dbPromise: Promise<IDBDatabase> | null = null;

	function openOnce(): Promise<IDBDatabase> {
		return new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(currentDbName(dbName), version);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(storeName))
					db.createObjectStore(storeName);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	function openDb(): Promise<IDBDatabase> {
		if (dbPromise) return dbPromise;
		dbPromise = (async () => {
			let db = await openOnce();
			// SHELL HEAL — see the file header.
			if (!db.objectStoreNames.contains(storeName)) {
				db.close();
				await new Promise<void>((res) => {
					const del = indexedDB.deleteDatabase(currentDbName(dbName));
					del.onsuccess = () => res();
					del.onerror = () => res();
					del.onblocked = () => res();
				});
				db = await openOnce();
			}
			return db;
		})();
		return dbPromise;
	}

	// ⚠️ Close the connection, don't just drop the reference — an open connection blocks deleteDatabase forever, which let a wipe report a store "clean" while it actually survived.
	registerOfflineDbReset(() => {
		const pending = dbPromise;
		dbPromise = null;
		void pending?.then((db) => db.close()).catch(() => {});
	});

	return {
		get(key: string): Promise<T | undefined> {
			return openDb().then(
				(db) =>
					new Promise<T | undefined>((res, rej) => {
						const r = db
							.transaction(storeName, "readonly")
							.objectStore(storeName)
							.get(key);
						r.onsuccess = () => res(r.result as T | undefined);
						r.onerror = () => rej(r.error);
					}),
			);
		},
		put(key: string, value: T): Promise<void> {
			return openDb().then(
				(db) =>
					new Promise<void>((res, rej) => {
						const t = db.transaction(storeName, "readwrite");
						t.objectStore(storeName).put(value, key);
						t.oncomplete = () => res();
						t.onerror = () => rej(t.error);
					}),
			);
		},
		delete(key: string): Promise<void> {
			return openDb().then(
				(db) =>
					new Promise<void>((res, rej) => {
						const t = db.transaction(storeName, "readwrite");
						t.objectStore(storeName).delete(key);
						t.oncomplete = () => res();
						t.onerror = () => rej(t.error);
					}),
			);
		},
		keys(): Promise<string[]> {
			return openDb().then(
				(db) =>
					new Promise<string[]>((res, rej) => {
						const r = db
							.transaction(storeName, "readonly")
							.objectStore(storeName)
							.getAllKeys();
						r.onsuccess = () => res((r.result as IDBValidKey[]).map(String));
						r.onerror = () => rej(r.error);
					}),
			);
		},
		/** ⚠️ project runs inside the IDB transaction: keep it pure and cheap, and never await in it or the transaction auto-closes. */
		getAllProjected<P>(project: (value: T) => P): Promise<P[]> {
			return openDb().then(
				(db) =>
					new Promise<P[]>((res, rej) => {
						const out: P[] = [];
						const r = db
							.transaction(storeName, "readonly")
							.objectStore(storeName)
							.openCursor();
						r.onsuccess = () => {
							const cur = r.result;
							if (!cur) {
								res(out);
								return;
							}
							out.push(project(cur.value as T));
							cur.continue();
						};
						r.onerror = () => rej(r.error);
					}),
			);
		},
		getAll(): Promise<T[]> {
			return openDb().then(
				(db) =>
					new Promise<T[]>((res, rej) => {
						const r = db
							.transaction(storeName, "readonly")
							.objectStore(storeName)
							.getAll();
						r.onsuccess = () => res(r.result as T[]);
						r.onerror = () => rej(r.error);
					}),
			);
		},
	};
}
