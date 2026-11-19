declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    /** Ignore the viewer's keyboard and pointer: watch, do not touch. */
    viewOnly: boolean;
    /** Take keyboard focus when the screen is clicked. */
    focusOnClick: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    /** CSS background behind the remote screen (letterboxing). */
    background: string;
    focus(options?: FocusOptions): void;
    disconnect(): void;
  }
}
