import { useRef } from "react";

export function AddSongButton({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="add-row">
      <button type="button" className="add-button" onClick={() => inputRef.current?.click()}>
        <span className="add-plus" aria-hidden="true">
          +
        </span>
        Add
      </button>
      <input
        ref={inputRef}
        className="file-proxy"
        type="file"
        accept="audio/mpeg,.mp3"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
