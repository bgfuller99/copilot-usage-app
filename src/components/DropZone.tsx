import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

interface Props {
  onFiles: (files: File[]) => void;
  busy: boolean;
  compact: boolean;
}

export function DropZone({ onFiles, busy, compact }: Props) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const files = [...e.dataTransfer.files];
      if (files.length) onFiles(files);
    },
    [onFiles],
  );

  const open = () => input.current?.click();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${compact ? ' compact' : ''}`}
      role="button"
      tabIndex={0}
      aria-label="Upload Excel files"
      onClick={open}
      onKeyDown={onKey}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <svg className="dz-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      <div>
        <strong>{busy ? 'Reading…' : compact ? 'Add more .xlsx files' : 'Drop Excel exports here'}</strong>
        {!compact && (
          <p>
            or <span className="link">browse</span> for one or more <code>.xlsx</code> files. Add several files to
            combine weeks.
          </p>
        )}
      </div>
    </div>
  );
}
