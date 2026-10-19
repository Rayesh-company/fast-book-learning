# نشست — the mobile client (Expo)

The product's Android client (ADR-0020): Expo + TypeScript, speaking the
**same backend's** wire protocol as the web sheet — one server, one API,
both clients. The base URL rides `EXPO_PUBLIC_API_URL` (default
`https://booksai.rayesh-team.ir`); against a dev machine's stack, point
it at the host (the Android emulator's loopback alias is
`10.0.2.2:8765`):

```bash
cd mobile
npm install
EXPO_PUBLIC_API_URL=http://10.0.2.2:8765 npx expo start
# then press a (Android) — or:
npx expo run:android        # a dev build on a connected device
```

An Account issues from the Admin console (the web sheet's «میز مدیریت»);
the login token lives in the device's secure store and rides
`Authorization: Bearer` on every call — the same signed token the web
cookie carries. The live line (`GET /events`) is the real-time surface:
an ask that settles on the web re-renders this app's Sessions list the
moment it lands.

Scope (v1, recorded in ADR-0020): login, the Sessions list, a sitting's
thread (the Quote selection, the Quoted answer's blocks, the research
conversation with its turn progress), and the composer. The Book
reader's raster pipeline, the full Notebook panel, and the Admin
console stay web-first. The strings are Farsi DRAFT
(`src/strings.ts`), the palette is the sheet's own tokens
(`src/theme.ts`).
