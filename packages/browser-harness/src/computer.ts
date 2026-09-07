import { tool } from 'ai';
import { z } from 'zod';

export interface DesktopControl {
  screenshot(): Promise<string>;
  click(x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): Promise<unknown>;
  type(text: string): Promise<unknown>;
  press(key: string, modifiers: string[]): Promise<unknown>;
  scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<unknown>;
}

/** These tools operate the SAME desktop/browser that the human sees over VNC. */
export function buildComputerTools(desktop: DesktopControl) {
  const coordinate = z.number().int().min(0).max(7680);
  return {
    computer_screenshot: tool({
      description: 'See the full Linux desktop, including browser chrome, terminals and other windows. Use the image coordinates for computer_click. Browser tools control the Chromium window on this same desktop.',
      inputSchema: z.object({}),
      execute: async () => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: await desktop.screenshot() } }),
      toModelOutput: ({ output }) => ({ type: 'content' as const, value: [{ type: 'image-data' as const, data: output.source.data, mediaType: 'image/png' }] }),
    }),
    computer_click: tool({
      description: 'Click a coordinate in the most recent full desktop screenshot.',
      inputSchema: z.object({ x: coordinate, y: coordinate, button: z.enum(['left', 'right', 'middle']).default('left'), double: z.boolean().default(false) }),
      execute: async ({ x, y, button, double }) => { await desktop.click(x, y, button, double); return 'Clicked desktop'; },
    }),
    computer_type: tool({
      description: 'Type text into the focused desktop application. Click the intended field first.',
      inputSchema: z.object({ text: z.string().max(20000) }),
      execute: async ({ text }) => { await desktop.type(text); return 'Typed into focused application'; },
    }),
    computer_press: tool({
      description: 'Press a desktop key, optionally with modifiers. Examples: key="l", modifiers=["ctrl"] focuses Chromium address bar; key="enter" submits; key="tab" moves focus.',
      inputSchema: z.object({ key: z.string().min(1).max(80), modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'super'])).max(4).default([]) }),
      execute: async ({ key, modifiers }) => { await desktop.press(key, modifiers); return 'Pressed desktop key'; },
    }),
    computer_scroll: tool({
      description: 'Scroll the desktop application under the given coordinate.',
      inputSchema: z.object({ x: coordinate, y: coordinate, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(50).default(3) }),
      execute: async ({ x, y, direction, amount }) => { await desktop.scroll(x, y, direction, amount); return 'Scrolled desktop'; },
    }),
  };
}
