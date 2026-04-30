import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';

export function Login() {
  const { login, user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };
  // Pre-fill demo credentials in dev only — never shipped to production
  // bundles. The seed script creates this account; in prod the form is empty.
  const [email, setEmail] = useState(import.meta.env.DEV ? 'demo@pipelineflow.app' : '');
  const [password, setPassword] = useState(import.meta.env.DEV ? 'demo1234' : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user) {
    return <Navigate to={location.state?.from?.pathname ?? '/'} replace />;
  }

  return (
    <AuthShell>
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Sign in to your PipelineFlow workspace.</p>
        </div>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setSubmitting(true);
            try {
              await login(email, password);
              navigate(location.state?.from?.pathname ?? '/');
            } catch (err) {
              setError((err as Error).message || 'Login failed');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button className="w-full" disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Sign in
          </Button>
        </form>
        <div className="text-sm text-muted-foreground">
          Don&apos;t have an account?{' '}
          <Link to="/register" className="font-medium text-foreground underline-offset-4 hover:underline">
            Create one
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-[hsl(240_18%_4%)] text-white md:flex md:flex-col md:justify-between md:p-10">
        {/* layered gradient mesh + grain */}
        <div aria-hidden className="absolute inset-0 mesh opacity-90" />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.18) 1px, transparent 0)',
            backgroundSize: '24px 24px',
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg brand-chip">
            <span className="text-sm font-bold">P</span>
          </div>
          <div className="text-sm font-semibold tracking-tight">PipelineFlow</div>
        </div>
        <div className="relative space-y-3">
          <p className="text-3xl font-semibold leading-tight tracking-tight">
            A clean, fast sales CRM.
            <br />
            <span className="text-gradient">Kanban-first.</span> Dark by default.
            <br />
            Keyboard-driven.
          </p>
          <p className="max-w-md text-sm text-zinc-400">
            Built for small teams that hate bloated CRMs. Track deals, pipeline value, and follow-ups
            without the ceremony.
          </p>
        </div>
        <div className="relative text-xs text-zinc-500">© {new Date().getFullYear()} PipelineFlow</div>
      </div>
      <div className="flex items-center justify-center px-4 py-12">{children}</div>
    </div>
  );
}
