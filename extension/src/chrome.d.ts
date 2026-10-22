// 확장이 쓰는 브라우저 API만 최소로 선언한다(@types/chrome 의존성을 넣지 않는다). Promise 형태(MV3)만 쓴다.
// Firefox도 MV3에서 chrome.* 이름공간을 Promise로 지원하고, browser.*가 있으면 그것을 먼저 쓴다.

declare namespace chrome {
  interface ExtensionEvent<Listener> {
    addListener(listener: Listener): void;
  }

  namespace runtime {
    interface MessageSender {
      readonly id?: string;
      readonly url?: string;
    }
    interface InstalledDetails {
      readonly reason: string;
    }
    function getURL(path: string): string;
    function sendMessage(message: unknown): Promise<unknown>;
    const id: string;
    const onInstalled: ExtensionEvent<(details: InstalledDetails) => void>;
    const onStartup: ExtensionEvent<() => void>;
    // true를 돌려주면 sendResponse를 나중에 부른다
    const onMessage: ExtensionEvent<(message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined>;
  }

  namespace storage {
    interface StorageArea {
      get(keys: readonly string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: readonly string[]): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace permissions {
    interface Permissions {
      readonly origins?: string[];
      readonly permissions?: string[];
    }
    function contains(permissions: Permissions): Promise<boolean>;
    function request(permissions: Permissions): Promise<boolean>;
    function remove(permissions: Permissions): Promise<boolean>;
    const onRemoved: ExtensionEvent<(permissions: Permissions) => void>;
  }

  namespace scripting {
    interface RegisteredContentScript {
      readonly id: string;
      readonly matches?: string[];
      readonly js?: string[];
      readonly runAt?: 'document_start' | 'document_end' | 'document_idle';
      readonly allFrames?: boolean;
      readonly persistAcrossSessions?: boolean;
    }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { readonly ids?: string[] }): Promise<void>;
    function getRegisteredContentScripts(filter?: { readonly ids?: string[] }): Promise<RegisteredContentScript[]>;
  }

  namespace tabs {
    interface Tab {
      readonly id?: number;
      readonly url?: string;
    }
    function query(query: { readonly active: boolean; readonly currentWindow: boolean }): Promise<Tab[]>;
  }
}

declare const browser: typeof chrome | undefined;
