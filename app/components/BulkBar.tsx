import { Icon, I } from "./Icon";

interface BulkBarProps {
  count: number;
  onDownload: () => void;
  onExport: () => void;
  onMarkReviewed: () => void;
  onArchive: () => void;
  onClear: () => void;
}

export function BulkBar({ count, onDownload, onExport, onMarkReviewed, onArchive, onClear }: BulkBarProps) {
  return (
    <div className="bulk" role="toolbar" aria-label="Bulk actions">
      <span>
        <strong>{count}</strong> selected
      </span>
      <span className="bulk-divider" aria-hidden="true" />
      <button className="bulk-act" onClick={onDownload}>
        <Icon d={I.download} size={13} /> Download
      </button>
      <button className="bulk-act" onClick={onExport}>
        <Icon d={I.excel} size={13} /> Export
      </button>
      <button className="bulk-act" onClick={onMarkReviewed}>
        <Icon d={I.check} size={13} /> Mark reviewed
      </button>
      <button className="bulk-act" onClick={onArchive}>
        <Icon d={I.trash} size={13} /> Archive
      </button>
      <button className="bulk-close" onClick={onClear} aria-label="Clear selection">
        <Icon d={I.x} size={13} />
      </button>
    </div>
  );
}
