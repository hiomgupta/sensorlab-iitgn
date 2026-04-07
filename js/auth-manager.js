/**
 * AuthManager — Firebase Authentication wrapper for SensorLab
 * Handles Google sign-in, sign-out, and auth state observation.
 * Falls back to guest mode if Firebase is not configured.
 */
class AuthManager {
    constructor() {
        this._user = null;
        this._listeners = [];
        this._initialized = false;
        this._mode = 'guest'; // 'guest' | 'signed-in'

        if (isFirebaseConfigured() && typeof firebase !== 'undefined') {
            try {
                if (!firebase.apps.length) {
                    firebase.initializeApp(FIREBASE_CONFIG);
                }
                this._auth = firebase.auth();
                this._setupAuthListener();
            } catch (e) {
                console.warn('[Auth] Firebase init failed, running in guest mode:', e.message);
                this._auth = null;
                this._setGuest();
            }
        } else {
            console.info('[Auth] Firebase not configured — guest mode only');
            this._auth = null;
            this._setGuest();
        }
    }

    _setupAuthListener() {
        this._auth.onAuthStateChanged((user) => {
            this._initialized = true;
            if (user) {
                this._user = {
                    uid: user.uid,
                    displayName: user.displayName || 'User',
                    email: user.email || '',
                    photoURL: user.photoURL || '',
                };
                this._mode = 'signed-in';
            } else {
                this._user = null;
                this._mode = 'guest';
            }
            this._notifyListeners();
        });
    }

    _setGuest() {
        this._initialized = true;
        this._user = null;
        this._mode = 'guest';
        // Notify on next tick so listeners have time to register
        setTimeout(() => this._notifyListeners(), 0);
    }

    // ── Public API ──

    get isSignedIn() { return this._mode === 'signed-in' && this._user !== null; }
    get isGuest() { return this._mode === 'guest'; }
    get user() { return this._user; }
    get uid() { return this._user?.uid || null; }
    get isAvailable() { return this._auth !== null; }

    onAuthChange(cb) {
        this._listeners.push(cb);
        // If already initialized, invoke immediately
        if (this._initialized) cb(this._user, this._mode);
    }

    _notifyListeners() {
        this._listeners.forEach(cb => cb(this._user, this._mode));
    }

    async signInWithGoogle() {
        if (!this._auth) throw new Error('Firebase not configured');
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await this._auth.signInWithPopup(provider);
    }

    async signOut() {
        if (!this._auth) return;
        await this._auth.signOut();
    }
}
