// =========================================================
// core/firebase-init.js
//
// One place holding the Firebase project config and doing
// startup wiring: anonymous sign-in (so Firestore security
// rules can require "must be signed in" without asking anyone
// to create an account) and Firestore with persistent local
// caching (so the app still works offline — writes queue up
// and sync automatically once back online).
//
// The apiKey/projectId etc. below are the *client* config —
// this is meant to be public and ships in the page source for
// every Firebase web app; it is not a secret. Real protection
// comes from the Firestore security rules (see firestore.rules
// in the project root), not from hiding this object.
// =========================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyCQbefTNKtIz7U2xWumb6JcATP32cpTFJo",
  authDomain: "supplier-returns-system.firebaseapp.com",
  projectId: "supplier-returns-system",
  storageBucket: "supplier-returns-system.firebasestorage.app",
  messagingSenderId: "1092221381242",
  appId: "1:1092221381242:web:843a6fb682b30cab4fe9c3",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// Every db.js call awaits this before touching Firestore, so
// nothing races the sign-in. Rejects (instead of hanging forever)
// if anonymous sign-in itself fails, so callers can show a real
// error instead of a silent stuck screen.
export const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => { if (user) resolve(user); });
  signInAnonymously(auth).catch((err) => {
    console.error('Firebase anonymous sign-in failed:', err);
    reject(err);
  });
});
