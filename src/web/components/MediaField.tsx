import { useRef, useState } from 'preact/hooks';
import { uploadToCloudinary } from '../api.ts';
import { useApp } from '../state.tsx';
import { cx, isVideoUrl, thumbUrl } from '../ui.ts';

interface Props {
  value: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
  large?: boolean;
}

interface Upload {
  id: number;
  name: string;
  progress: number;
}

const CONCURRENCY = 3;
let uploadSeq = 0;

export function MediaField({ value, onChange, disabled, large }: Props) {
  const { data, toast } = useApp();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // Latest list, so concurrent uploads append instead of overwriting each other.
  const latest = useRef(value);
  latest.current = value;

  async function uploadAll(files: File[]) {
    if (!data || !files.length) return;
    const queue = files.map((file) => ({ file, id: ++uploadSeq }));
    setUploads((u) => [...u, ...queue.map(({ file, id }) => ({ id, name: file.name, progress: 0 }))]);

    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { file, id } = job;
        try {
          const url = await uploadToCloudinary(file, data.settings, (p) =>
            setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))),
          );
          latest.current = [...latest.current, url];
          onChange(latest.current);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
          setUploads((u) => u.filter((x) => x.id !== id));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  }

  function move(i: number, delta: number) {
    const next = value.slice();
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }

  function addUrl() {
    const url = urlDraft.trim();
    if (!/^https:\/\/\S+$/.test(url)) return toast('קישור חייב להתחיל ב-https://', 'warn');
    onChange([...value, url]);
    setUrlDraft('');
  }

  return (
    <div class="media-field">
      {value.length > 0 && (
        <div class="media-grid">
          {value.map((url, i) => (
            <figure key={url + i} class="media-item">
              <img src={thumbUrl(url, 320)} alt="" loading="lazy" />
              {isVideoUrl(url) && <span class="media-badge">▶ וידאו</span>}
              {!disabled && (
                <div class="media-actions">
                  {value.length > 1 && (
                    <>
                      <button type="button" class="icon" title="הזז ימינה" onClick={() => move(i, -1)}>
                        →
                      </button>
                      <button type="button" class="icon" title="הזז שמאלה" onClick={() => move(i, 1)}>
                        ←
                      </button>
                    </>
                  )}
                  <button type="button" class="icon danger" title="הסרה" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </div>
              )}
            </figure>
          ))}
        </div>
      )}

      {uploads.map((u) => (
        <div key={u.id} class="upload-row">
          <span>{u.name}</span>
          <progress max={1} value={u.progress} />
        </div>
      ))}

      {!disabled && (
        <>
          <div
            class={cx('dropzone', large && 'large', dragOver && 'over')}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void uploadAll([...(e.dataTransfer?.files ?? [])]);
            }}
            onPaste={(e) => void uploadAll([...(e.clipboardData?.files ?? [])])}
            tabIndex={0}
            role="button"
          >
            <strong>📤 {value.length ? 'הוספת קבצים' : 'העלאת תמונות / וידאו'}</strong>
            <span>גרירה לכאן, הדבקה או לחיצה לבחירה (אפשר כמה)</span>
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              const el = e.currentTarget;
              void uploadAll([...(el.files ?? [])]);
              el.value = '';
            }}
          />
          <div class="inline-form">
            <input
              type="url"
              dir="ltr"
              placeholder="או הדבק קישור https://..."
              value={urlDraft}
              onInput={(e) => setUrlDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addUrl())}
            />
            <button type="button" onClick={addUrl} disabled={!urlDraft.trim()}>
              הוספה
            </button>
          </div>
        </>
      )}
    </div>
  );
}
