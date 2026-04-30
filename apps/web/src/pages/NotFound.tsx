import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="text-6xl font-bold text-muted-foreground">404</div>
      <h1 className="mt-2 text-xl font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">We can&apos;t find what you&apos;re looking for.</p>
      <Button asChild variant="outline" className="mt-6">
        <Link to="/">Go to dashboard</Link>
      </Button>
    </div>
  );
}
