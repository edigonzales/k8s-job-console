// Headlamp v0.46.0 exposes this registry API. SDK 0.14.0 predates its declaration.
import '@kinvolk/headlamp-plugin/lib';

declare module '@kinvolk/headlamp-plugin/lib' {
  export function registerHomeSidebarEntryFilter<T extends { name: string }>(
    filter: (entry: T) => T | null
  ): void;
}
