/**
 * Firebase Configuration for SensorLab
 *
 * HOW TO SET UP:
 * 1. Go to https://console.firebase.google.com/
 * 2. Create a new project (e.g. "sensorlab-iitgn")
 * 3. Add a Web App (Project Settings → General → Your apps → Add app → Web)
 * 4. Copy the firebaseConfig object below and replace the placeholder values
 * 5. Enable Authentication → Sign-in method → Google
 * 6. Enable Firestore Database → Create database → Start in test mode
 * 7. (Optional) Deploy to Firebase Hosting for free HTTPS
 *
 * SECURITY: Firestore Security Rules MUST restrict access per user.
 * Replace the default test-mode rules with:
 *   rules_version = '2';
 *   service cloud.firestore {
 *     match /databases/{database}/documents {
 *       match /users/{userId}/{document=**} {
 *         allow read, write: if request.auth != null && request.auth.uid == userId;
 *       }
 *     }
 *   }
 */
const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyA8M5Wq8Fr_nObn8c1TTYEl8UD64UO38Kc",
    authDomain:        "sensorlab-iitgn.firebaseapp.com",
    projectId:         "sensorlab-iitgn",
    storageBucket:     "sensorlab-iitgn.firebasestorage.app",
    messagingSenderId: "646706627654",
    appId:             "1:646706627654:web:3825a28c4e36af7e7d7647"
};

// Check if Firebase config is set up
function isFirebaseConfigured() {
    return FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
}
