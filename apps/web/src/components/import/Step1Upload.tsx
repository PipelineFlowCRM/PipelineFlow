import { useRef, useState } from 'react';
import { Building2, Contact, Handshake, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { EntityType, UploadResponse } from '@/lib/import/api';
import { importApi } from '@/lib/import/api';
import { toast } from 'sonner';

interface Props {
  onUploaded: (entityType: EntityType, response: UploadResponse, file: File) => void;
}

const ENTITIES: { value: EntityType; label: string; description: string; icon: typeof Building2 }[] = [
  {
    value: 'company',
    label: 'Companies',
    description: 'Organizations with names, websites, addresses.',
    icon: Building2,
  },
  {
    value: 'contact',
    label: 'Contacts',
    description: 'People — link to companies you imported first.',
    icon: Contact,
  },
  {
    value: 'deal',
    label: 'Deals',
    description: 'Opportunities. Needs stages mapped before commit.',
    icon: Handshake,
  },
];

export function Step1Upload({ onUploaded }: Props) {
  const [entityType, setEntityType] = useState<EntityType>('contact');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast.error('Please upload a .csv file');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File is too large (max 10 MB)');
      return;
    }
    setUploading(true);
    try {
      const res = await importApi.upload(file, entityType);
      onUploaded(entityType, res, file);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold">1. What are you importing?</h3>
        <p className="text-xs text-muted-foreground">
          Pick the type of record this CSV represents. You'll re-run the
          wizard once per entity type — Companies first, then Contacts,
          then Deals — so cross-references resolve cleanly.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {ENTITIES.map((e) => {
            const Icon = e.icon;
            const active = entityType === e.value;
            return (
              <button
                key={e.value}
                type="button"
                onClick={() => setEntityType(e.value)}
                className={cn(
                  'rounded-lg border border-border/70 bg-card p-3 text-left transition-colors hover:border-border',
                  active && 'border-primary/60 ring-1 ring-primary/40',
                )}
              >
                <Icon className={cn('mb-2 h-4 w-4', active ? 'text-primary' : 'text-muted-foreground')} />
                <div className="text-sm font-medium">{e.label}</div>
                <div className="text-xs text-muted-foreground">{e.description}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold">2. Upload the CSV</h3>
        <p className="text-xs text-muted-foreground">
          Drop a `.csv` file (≤10 MB, ≤50,000 rows). UTF-8 with BOM and
          mixed line endings are fine. Pipedrive / HubSpot / Salesforce
          exports get auto-detected.
        </p>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void handleFile(f);
          }}
          className={cn(
            'mt-3 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/70 bg-muted/20 px-6 py-12 transition-colors hover:border-primary/50',
            dragOver && 'border-primary/60 bg-muted/40',
            uploading && 'pointer-events-none opacity-60',
          )}
        >
          {uploading ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="h-6 w-6 text-muted-foreground" />
          )}
          <div className="text-sm font-medium">
            {uploading ? 'Uploading…' : 'Drop a CSV here, or click to browse'}
          </div>
          <div className="text-xs text-muted-foreground">
            We'll parse it server-side and show you a column-mapping step next.
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-1"
            onClick={(e) => {
              e.preventDefault();
              inputRef.current?.click();
            }}
            disabled={uploading}
          >
            Choose file
          </Button>
        </label>
      </section>
    </div>
  );
}
