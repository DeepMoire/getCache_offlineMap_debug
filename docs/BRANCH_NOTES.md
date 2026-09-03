# Branch notes — offline map (sessione direction2.5)

> Stato al termine della chat del 2026-09-02. `main` è stato fast-forwardato a `direction2.5` e spinto su origin.

## Cosa c'è in ogni branch

| Branch | Contenuto |
|---|---|
| **main** | Ora = `direction2.5` (merge ff `b3c6160`). Prima conteneva solo il pack hospitals offline + fix npm install. È il punto di partenza per testare tutto il lavoro della sessione. |
| **direction1** | Direzione abbandonata presto: docs "ring doctrine" in OFFLINE_PLAN/OFFLINE_MAP_SPEC + ignore di `.vscode/`. Solo storico. |
| **direction2 / 2.1** | Stessa punta (`8938ebe`). Ammazza lo stretch-tier sotto z8 (`RAW_MIN_Z = BLOB_MIN_Z`) e mette in quarantena zoom stranieri nella lookup dei tile. |
| **direction2.2** | Perf gestures: letture merge memoizzate + merge O(n) + key set in memoria — zoom non si freeza più. In più: test e2e di confutazione (merge layer VERBATIM), fix bug ledger "2 tiles / —" (snapshot a inizio pass azzerava lineBytes appena scritti). |
| **direction2.3** | Tier shallow z6: tile z6 verbatim dall'archivio per pin, store/source/protocol propri (`rtraw-shallow`), layer relay z6–z7. |
| **direction2.4** | Tier shallow z6 COSTRUITO dalle letture z13 del disco (non più verbatim): `SHALLOW_LAYER_RULES` assottiglia le strade; zero letture R2 extra. Il commit in punta ("direction2.6") corregge il vocabolario (major_road/minor_road reali), **pv 47→48** (i pin già cotti si riscaricano) e fa disegnare l'acqua del tier (`v4-water-fill/line-shallow`). |
| **direction2.5** | **Il ghost grid di questa chat**: un quadrato bianco per pin = il bounding box reale del suo tileset (`radiusBox`, 60×60 km centrato sul pin — NON le celle z8 di `cellsFor`). In fondo allo stack, solo fill senza outline, rampa opacità `[[6, 0.01], [7.9, 0]]`: visibile solo sotto z6, sfuma a 0 verso z8. Fix correlato: `addSource(BLOB_GRID_SOURCE)` spostato PRIMA del loop `wallLayers()` (MapLibre monta silenziosamente male un layer la cui source non esiste). Test: 7 in `blobGrid.test.ts`. |

File nuovi della 2.5: `lib/onPhone/render/blobGrid.ts` + `blobGrid.test.ts`; modificati `wallStyle.ts` (layer + rampa) e `OfflineMapPage.svelte` (source prima dei layer).

## Cosa fare per prenderlo e testarlo

```bash
git fetch origin
git checkout main && git pull        # sei su b3c6160
npm install                          # c'è ora il package-lock.json committato
npx vitest run                       # suite completa (883+ test; ~54 fallimenti ambientali noti su macchine senza deps locali)
```

Per il test **a runtime** (telefono/debugger):
1. Vite + worker: `npm run dev` (vite su :5174) e `wrangler dev` in `workers/worker-local-dev/`.
2. Attenzione: **pv 47→48** — i pin già cotti si ri-cottiscono/riscaricano al primo avvio, è voluto.
3. Check visivo del ghost grid: zoom **sotto z6** — un quadrato bianco appena percettibile (1%) centrato su ogni pin; salendo verso z8 sfuma e sparisce. Sopra z8 non c'è, by design.

## Nota deploy (differita, non fatta in questa chat)

I worker cloud non sono ancora aggiornati: quando si deploya, **prima il Worker poi l'app** (il telefono parla il protocollo nuovo solo dopo il worker). Le modifiche cloud toccano `workers/worker-{cloud-dev,cloud-prod}/src/{packBuilder,mvtFilter,index}.ts`.
