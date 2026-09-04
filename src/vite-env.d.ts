interface ImportMetaEnv {
  readonly VITE_E2E_FETCH_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
