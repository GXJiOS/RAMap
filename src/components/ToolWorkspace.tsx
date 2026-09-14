import { type ReactNode, useState } from 'react';
import { errorMessage } from '../lib/tool-actions';

export function ToolWorkspace({ title, description, actions, children, error, status }: {
  title: string; description?: string; actions?: ReactNode; children: ReactNode; error?: string; status?: ReactNode;
}) {
  return <section className="workbench" aria-label={title}>
    <header className="workbench-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="work-actions">{actions}</div></header>
    {error && <div className="work-error" role="alert">{error}</div>}
    {children}
    {status && <div className="work-status" role="status">{status}</div>}
  </section>;
}

export function Panel({ title, actions, children, className = '' }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`work-panel ${className}`}>{(title || actions) && <header><h2>{title}</h2><div className="work-actions">{actions}</div></header>}<div className="work-panel-body">{children}</div></section>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="work-field"><span>{label}</span>{children}</label>;
}

export function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange(value: T): void }) {
  return <Field label={label}><select value={value} onChange={(event) => onChange(event.target.value as T)}>{options.map(([key, text]) => <option value={key} key={key}>{text}</option>)}</select></Field>;
}

export function Action({ children, onAction, disabled = false, primary = false }: { children: ReactNode; onAction(): unknown | Promise<unknown>; disabled?: boolean; primary?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <span className="work-action"><button className={`work-button ${primary ? 'is-primary' : ''}`} disabled={disabled || pending} type="button" onClick={async () => {
    setError(''); setPending(true);
    try { await onAction(); } catch (cause) { setError(errorMessage(cause)); } finally { setPending(false); }
  }}>{pending ? '处理中…' : children}</button>{error && <span className="work-action-error" role="alert">{error}</span>}</span>;
}
