// Fill these in to turn on syncing across devices and exact YouTube Music album links.
// Both are safe to publish: Firebase web config is public by design (access is
// controlled by firestore.rules), and the YouTube key is restricted to this site.
window.CRATE_CONFIG = {
  firebase: null,      // paste the firebaseConfig object from the Firebase console here
  youtubeApiKey: "",   // optional: a YouTube Data API v3 key
};
