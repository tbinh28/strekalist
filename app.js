// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAWCqyV9gkBAFaHqZcQ-bL6eytdvDdS6CU",
  authDomain: "strekalist.firebaseapp.com",
  projectId: "strekalist",
  storageBucket: "strekalist.firebasestorage.app",
  messagingSenderId: "384201323520",
  appId: "1:384201323520:web:ad33f1d985a29014c314e5",
  measurementId: "G-KBD8L7W6H4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);