# Crate

My albums on shelves, by period of my life. Every cover opens the album in YouTube Music.

- Search any album live (Deezer's public catalog), with suggestions for every shelf.
- Saved in the browser; signing in with Google syncs the library across devices (Firebase).
- Static site: no build step. `config.js` holds the Firebase web config and an optional YouTube Data API key.
- `firestore.rules` limits each signed-in person to their own `users/<uid>/` data.
