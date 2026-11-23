import { initializeApp } from 'firebase/app';
import {
    initializeAuth, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider,
    onAuthStateChanged, signInWithPopup, signOut,
} from 'firebase/auth';
import { getFirestore, doc, setDoc, serverTimestamp } from 'firebase/firestore/lite';

export function createFirebaseBackend(config) {
    const app = initializeApp(config);
    const auth = initializeAuth(app, { persistence: browserLocalPersistence });
    const db = getFirestore(app);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    function requireUser(uid) {
        if (auth.currentUser?.uid !== uid) throw new Error('The signed-in account changed. Sign in to the recording owner account.');
        return auth.currentUser;
    }

    return {
        observeUser: callback => onAuthStateChanged(auth, callback),
        signIn: () => signInWithPopup(auth, provider, browserPopupRedirectResolver),
        signOut: () => signOut(auth),
        async verifyUser(uid) {
            const user = requireUser(uid);
            await user.getIdToken(true);
            requireUser(uid);
        },
        async saveProfile(user) {
            requireUser(user.uid);
            await setDoc(doc(db, 'users', user.uid), {
                uid: user.uid,
                email: user.email ?? null,
                displayName: user.displayName ?? null,
                photoURL: user.photoURL ?? null,
                emailVerified: user.emailVerified,
                provider: 'google.com',
                createdAt: user.metadata.creationTime ?? null,
                lastSignInAt: serverTimestamp(),
            });
        },
        async savePart(uid, sessionId, part) {
            requireUser(uid);
            await setDoc(doc(db, 'users', uid, 'sessions', sessionId, 'parts', part.id), part.data);
        },
        async completeSession(uid, sessionId, manifest) {
            requireUser(uid);
            await setDoc(doc(db, 'users', uid, 'sessions', sessionId), { ...manifest, uploadedAt: serverTimestamp() });
        },
    };
}
