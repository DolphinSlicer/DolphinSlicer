/// <reference types="vite/client" />
declare const __APP_COMMIT__: string;
declare const __APP_SOURCE_URL__: string;
interface ImportMetaEnv {
  /** 'pi' for the self-hosted build served over plain HTTP from the printer (npm run build:pi). */
  readonly VITE_TARGET?: string;
}
