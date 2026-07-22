import { app } from 'electron'

/**
 * PIN THE DATA-FOLDER IDENTITY. This module exists ONLY for its side effect, and it must be the FIRST
 * thing the main process imports — before the logger, before the DB, before anything that resolves
 * `app.getPath('userData')`.
 *
 * WHY A WHOLE MODULE for one line: a bare statement placed between imports in index.ts does NOT run
 * first. ES imports are hoisted, and electron-vite/esbuild bundles every `import`'s side effects ahead
 * of top-level statements — verified in the built output, where a `app.setName()` written at the top of
 * index.ts was moved thousands of lines BELOW `log.initialize()`. A module's body, by contrast, runs in
 * import order. So `import './app-identity'` as the first import guarantees this executes first.
 *
 * WHAT IT GUARDS. The app is now displayed as "Malgary Labs POS" (electron-builder.yml productName), and
 * Electron derives the userData folder from the app name. Left alone, the next update would move the
 * database to `.../Malgary Labs POS/pos.db` and every existing install would open EMPTY, its real books
 * stranded in `.../Insha POS/`. A rename must never move a shop's money. So the name is pinned back to
 * "Insha POS" for PATH purposes only — the window title and every on-screen label still read
 * "Malgary Labs POS" (set independently from @shared/branding). Display-only rebranding, as chosen.
 *
 * setName after a userData path has first been read is a no-op — which is the bug this prevents.
 */
app.setName('Insha POS')
