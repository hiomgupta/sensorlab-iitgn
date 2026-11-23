export function validateCloudConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Firebase configuration must be a JSON object.');
    const allowed = ['apiKey', 'authDomain', 'projectId', 'appId'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Supply only apiKey, authDomain, projectId, and appId. Never supply service-account credentials.');
    for (const key of allowed) {
        if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`Firebase configuration requires ${key}.`);
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId)) throw new Error('Invalid Firebase projectId.');
    if (input.authDomain !== `${input.projectId}.firebaseapp.com`) throw new Error('Use the Firebase-provided projectId.firebaseapp.com authDomain.');
    if (!/^[A-Za-z0-9_-]+$/.test(input.apiKey) || !/^[A-Za-z0-9:]+$/.test(input.appId)) throw new Error('Invalid Firebase apiKey or appId.');
    return Object.fromEntries(allowed.map(key => [key, input[key]]));
}

export function cloudCsp(config) {
    return `default-src 'self'; script-src 'self' https://apis.google.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://${config.authDomain}; frame-src https://${config.authDomain}; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
