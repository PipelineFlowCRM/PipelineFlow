import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { TagChip } from '@/components/tags/TagChip';
import { TagEditPopover } from '@/components/tags/TagEditPopover';
import { useCreateTag, useTags } from '@/components/tags/useTags';
import { DEFAULT_TAG_COLOR } from '@/components/tags/tagPalette';

export function TagsCard() {
  const { data } = useTags();
  const create = useCreateTag();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_TAG_COLOR);

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const result = await create.mutateAsync({ name, color: newColor });
      if (result.kind === 'existed') {
        toast.error(`Tag "${result.tag.name}" already exists`);
      } else {
        setNewName('');
      }
    } catch (e) {
      if (e instanceof ApiError) {
        toast.error(e.message);
      } else {
        toast.error('Failed to create tag');
      }
    }
  };

  return (
    // Form-style card — same width discipline as Stages so the new-tag
    // form input doesn't run the full content column.
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Tags</CardTitle>
        <CardDescription>
          Categorize deals, companies, and contacts. Click any tag to rename, recolor, or delete.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {data?.tags.map((t) => (
            <TagEditPopover key={t.id} tag={t}>
              <TagChip
                tag={t}
                interactive
                size="md"
                className="cursor-pointer"
              />
            </TagEditPopover>
          ))}
          {data && data.tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tags yet. Create one below.</p>
          ) : null}
        </div>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate();
          }}
        >
          <input
            type="color"
            aria-label="New tag color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="h-9 w-9 cursor-pointer rounded border"
          />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New tag name"
            placeholder="New tag name"
            className="flex-1 max-w-sm"
          />
          <Button size="sm" disabled={!newName.trim() || create.isPending}>
            <Plus /> Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
