import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { Login } from '@/pages/auth/Login';
import { Register } from '@/pages/auth/Register';
import { Dashboard } from '@/pages/Dashboard';
import { Pipeline } from '@/pages/Pipeline';
import { Deals } from '@/pages/deals/Deals';
import { DealDetail } from '@/pages/deals/DealDetail';
import { DealNew } from '@/pages/deals/DealNew';
import { Companies } from '@/pages/companies/Companies';
import { CompanyDetail } from '@/pages/companies/CompanyDetail';
import { Contacts } from '@/pages/contacts/Contacts';
import { ContactDetail } from '@/pages/contacts/ContactDetail';
import { Tasks } from '@/pages/tasks/Tasks';
import { Reports } from '@/pages/Reports';
import { Settings } from '@/pages/Settings';
import { Profile } from '@/pages/Profile';
import { NotFound } from '@/pages/NotFound';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="deals" element={<Deals />} />
        <Route path="deals/new" element={<DealNew />} />
        <Route path="deals/:id" element={<DealDetail />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<CompanyDetail />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="contacts/:id" element={<ContactDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
