export interface TelegramMiniApp {
  initData: string;
  ready(): void;
  openLink(url: string): void;
}

declare global {
  interface Window { Telegram?: { WebApp?: TelegramMiniApp } }
}

let loading: Promise<TelegramMiniApp> | undefined;

/** Load only on the connection page; never persist or log signed launch data. */
export function loadTelegramMiniApp(): Promise<TelegramMiniApp> {
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);
  if (loading) return loading;
  loading = new Promise<TelegramMiniApp>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => fail(), 10000);
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("Telegram could not load. Close this page and open the Connect button again."));
    };
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.onload = () => {
      window.clearTimeout(timer);
      const app = window.Telegram?.WebApp;
      if (app) resolve(app); else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}
