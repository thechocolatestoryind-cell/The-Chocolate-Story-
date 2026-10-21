// firebase.js — single source of Firebase initialisation for the storefront.
// The future admin panel must use these exact same config values.
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup,
  signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  setDoc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyClfoi9k0ylFwlOulpHMVuW7Ldfcd4yGFA",
  authDomain: "the-chocolate-story.firebaseapp.com",
  projectId: "the-chocolate-story",
  storageBucket: "the-chocolate-story.firebasestorage.app",
  messagingSenderId: "1025784042622",
  appId: "1:1025784042622:web:393ed47e07d53f475c742f",
  measurementId: "G-WJ69TV6ZT8"
};

// Never initialise twice (every page imports this module, but ES modules run once per page load).
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export {
  app, auth, db, googleProvider,
  onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  setDoc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp, arrayUnion, arrayRemove
};
