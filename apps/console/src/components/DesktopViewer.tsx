import { useEffect, useRef, useState } from 'react';
import { useApi } from '../lib/api';
import { Button } from './ui/button';

/** noVNC uses our single-use app ticket; provider credentials stay server-side. */
export function DesktopViewer({ agentId }: { agentId: string }) {
  const { api } = useApi();
  const target = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('Connecting');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !target.current) return;
    let disposed = false;
    let rfb: import('@novnc/novnc').default | undefined;
    setStatus('Connecting'); setError('');
    void (async () => {
      const { url } = await api<{ url: string }>(`/v1/agents/${agentId}/machine/desktop-ticket`, { method: 'POST', body: '{}' });
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !target.current) return;
      const endpoint = new URL(url, window.location.href);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      rfb = new RFB(target.current, endpoint.href);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener('connect', () => setStatus('Connected'));
      rfb.addEventListener('disconnect', () => { if (!disposed) setStatus('Disconnected'); });
      rfb.addEventListener('securityfailure', () => setError('Desktop connection failed. Close the desktop and reconnect.'));
    })().catch(err => { if (!disposed) setError(err instanceof Error ? err.message : 'Desktop connection failed'); });
    return () => { disposed = true; rfb?.disconnect(); };
  }, [open, agentId, api]);
  return <div className="mt-4 border-t border-border pt-4">
    <div className="flex justify-between items-center gap-3">
      <div><h3 className="text-sm font-medium">Live desktop</h3><p className="text-xs text-fg-subtle">View and control the agent's Linux desktop. Closing this viewer leaves its work running.</p></div>
      <Button variant="outline" size="sm" onClick={() => setOpen(v => !v)}>{open ? 'Close desktop' : 'Open desktop'}</Button>
    </div>
    {open && <>
      <p role="status" className="my-2 text-sm">{status}</p>
      {error && <p role="alert" className="text-danger text-sm">{error}</p>}
      <div ref={target} className="w-full h-[600px] rounded-md overflow-hidden border border-border bg-black" aria-label="Agent Linux desktop" />
    </>}
  </div>;
}
