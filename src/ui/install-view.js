import { $, openDialog } from './dom.js';

export class InstallView {
    constructor(win = window) {
        this.window = win;
        this.deferredPrompt = null;
        this.button = $('installBtn');
        this.dialog = $('installDialog');
        this.installAction = $('installAction');
        this.status = $('installStatus');

        this.button.addEventListener('click', () => openDialog(this.dialog));
        this.installAction.addEventListener('click', () => this.install());
        this.window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            this.deferredPrompt = event;
            this.installAction.hidden = false;
        });
        this.window.addEventListener('appinstalled', () => {
            this.deferredPrompt = null;
            this.installAction.hidden = true;
            this.button.hidden = true;
            this.status.textContent = 'SensorLab is installed. Open it from your home screen.';
        });

        if (this.isInstalled()) this.button.hidden = true;
    }

    isInstalled() {
        return this.window.matchMedia?.('(display-mode: standalone)').matches
            || this.window.navigator.standalone === true;
    }

    async install() {
        const prompt = this.deferredPrompt;
        if (!prompt) return;

        this.installAction.disabled = true;
        this.status.textContent = 'Waiting for Chrome’s installation choice…';
        try {
            await prompt.prompt();
            const choice = await prompt.userChoice;
            this.status.textContent = choice.outcome === 'accepted'
                ? 'SensorLab was added to your home screen.'
                : 'Installation was cancelled. You can still add it from Chrome’s menu.';
        } catch (error) {
            this.status.textContent = `Chrome could not open the install prompt (${error.message}). Use Chrome’s menu to add SensorLab to your home screen.`;
        } finally {
            this.deferredPrompt = null;
            this.installAction.hidden = true;
            this.installAction.disabled = false;
        }
    }
}
