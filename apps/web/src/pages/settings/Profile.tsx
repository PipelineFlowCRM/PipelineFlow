import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, LogOut, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { initials, relativeTime } from '@/lib/utils';
import { uploadToS3 } from '@/lib/upload';
import { toast } from 'sonner';
import type { UserDto } from '@pipelineflow/shared';

interface SessionRow {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

const COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#a855f7','#ec4899','#14b8a6'];

export function Profile() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;
  // Active settings section ("Profile") is conveyed by the SettingsLayout
  // nav rail — no inline page header needed. Internal Radix Tabs split the
  // four sub-views, matching the pattern CustomFieldsCard already uses.
  // max-w-2xl keeps the form columns at a comfortable reading/editing
  // width — the rail already eats some horizontal space on desktop, and
  // a 1200px-wide name input is cargo-cult full-width design.
  return (
    <Tabs defaultValue="general" className="max-w-2xl space-y-4">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="sessions">Sessions</TabsTrigger>
        <TabsTrigger value="danger">Danger</TabsTrigger>
      </TabsList>

      <TabsContent value="general"><GeneralTab user={user} setUser={setUser} /></TabsContent>
      <TabsContent value="security"><SecurityTab /></TabsContent>
      <TabsContent value="sessions"><SessionsTab /></TabsContent>
      <TabsContent value="danger">
        <DangerTab onDeleted={async () => { await logout(); navigate('/login'); }} />
      </TabsContent>
    </Tabs>
  );
}

function GeneralTab({ user, setUser }: { user: UserDto; setUser: (u: UserDto) => void }) {
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.avatarColor);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setName(user.name); setColor(user.avatarColor); setAvatarUrl(user.avatarUrl); }, [user]);

  // After an avatar change the API enqueues the old S3 key for deletion, so
  // any cached deal/dashboard/company response containing the prior presigned
  // URL in `author.avatarUrl` / `actor.avatarUrl` will start 403-ing. Refetch
  // those views by invalidating broadly — avatar changes are rare enough
  // that the extra fetches are fine.
  const invalidateAvatarConsumers = () => {
    qc.invalidateQueries({ queryKey: ['deal'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['company'] });
  };

  const saveMut = useMutation({
    mutationFn: () =>
      api.patch<{ user: UserDto }>('/profile/me', {
        name, avatarColor: color, avatarUrl, theme,
      }),
    onSuccess: ({ user }) => {
      setUser(user);
      invalidateAvatarConsumers();
      toast.success('Profile saved');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>How you appear across PipelineFlow.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16">
            {avatarUrl ? <AvatarImage src={avatarUrl} /> : null}
            <AvatarFallback color={color}>{initials(name)}</AvatarFallback>
          </Avatar>
          <div className="space-y-2">
            <label className="inline-flex">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={busy}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBusy(true);
                  try {
                    const { key } = await uploadToS3(file, 'avatar');
                    // The S3 key is opaque on the client; the API resolves
                    // it to a presigned GET URL when serializing the user.
                    // Save right away so the new URL flows back through
                    // /profile/me and the avatar renders without a refresh.
                    const { user: updated } = await api.patch<{ user: UserDto }>('/profile/me', {
                      avatarUrl: key,
                    });
                    setAvatarUrl(updated.avatarUrl);
                    setUser(updated);
                    invalidateAvatarConsumers();
                    toast.success('Avatar updated');
                  } catch (err) {
                    toast.error((err as Error).message || 'Upload failed');
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" asChild>
                <span className="cursor-pointer"><Camera /> Upload</span>
              </Button>
            </label>
            {avatarUrl ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAvatarUrl(null)}>
                Remove avatar
              </Button>
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Display name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="max-w-sm"
          />
        </div>

        <div className="space-y-2">
          <Label>Avatar color</Label>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-7 w-7 rounded-full border-2 ${color === c ? 'ring-2 ring-ring' : ''}`}
                style={{ background: c, borderColor: c === color ? c : 'transparent' }}
              />
            ))}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <Label>Theme</Label>
          <Select value={theme} onValueChange={(v) => setTheme(v as 'system' | 'light' | 'dark')}>
            <SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>Save changes</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SecurityTab() {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [email, setEmail] = useState('');
  const [emailPw, setEmailPw] = useState('');

  const pwMut = useMutation({
    mutationFn: () => api.post('/profile/change-password', { currentPassword, newPassword, confirmPassword: confirm }),
    onSuccess: () => { toast.success('Password updated'); setCurrent(''); setNew(''); setConfirm(''); },
    onError: (e) => toast.error((e as Error).message),
  });

  const emailMut = useMutation({
    mutationFn: () => api.post('/profile/change-email', { email, password: emailPw }),
    onSuccess: () => { toast.success('Email updated'); setEmail(''); setEmailPw(''); },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Change password</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Current password</Label>
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              className="max-w-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>New password</Label>
            <Input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              className="max-w-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Confirm</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="max-w-sm"
            />
          </div>
          <div className="flex justify-end">
            <Button disabled={pwMut.isPending} onClick={() => pwMut.mutate()}>Update password</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Change email</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>New email</Label>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="max-w-md"
            />
          </div>
          <div className="space-y-2">
            <Label>Confirm with password</Label>
            <Input
              type="password"
              autoComplete="current-password"
              value={emailPw}
              onChange={(e) => setEmailPw(e.target.value)}
              className="max-w-sm"
            />
          </div>
          <div className="flex justify-end">
            <Button disabled={emailMut.isPending} onClick={() => emailMut.mutate()}>Update email</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SessionsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ sessions: SessionRow[] }>('/profile/sessions'),
  });
  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/profile/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const revokeAllMut = useMutation({
    mutationFn: () => api.post('/profile/sessions/revoke-others'),
    onSuccess: () => { toast.success('Other sessions signed out'); qc.invalidateQueries({ queryKey: ['sessions'] }); },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Devices currently signed in.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => revokeAllMut.mutate()}>
            <LogOut /> Sign out other sessions
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.sessions.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">
                {s.userAgent ?? 'Unknown device'} {s.current ? <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">This device</span> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.ipAddress ?? '—'} · last seen {relativeTime(s.lastSeenAt)} · #{s.label}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => revokeMut.mutate(s.id)}>
              <Trash2 /> Revoke
            </Button>
          </div>
        ))}
        {data && data.sessions.length === 0 ? <p className="text-sm text-muted-foreground">No active sessions.</p> : null}
      </CardContent>
    </Card>
  );
}

function DangerTab({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.delete('/profile/me'),
    onSuccess: onDeleted,
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          This permanently removes your user record and signs out every device. Deals,
          notes, and files you authored stay in the workspace but show no owner.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-end">
          <Button variant="destructive" onClick={() => setOpen(true)} disabled={mut.isPending}>
            <Trash2 /> Delete my account
          </Button>
        </div>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Delete your account"
          description="Your sessions are revoked immediately. Authored content stays in the workspace as ownerless."
          requireTyped="DELETE"
          confirmLabel="Delete account"
          busy={mut.isPending}
          onConfirm={() => mut.mutate()}
        />
      </CardContent>
    </Card>
  );
}
