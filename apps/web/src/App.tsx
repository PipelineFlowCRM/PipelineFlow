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
import { SettingsLayout } from '@/pages/settings/SettingsLayout';
import { StagesCard } from '@/pages/settings/StagesCard';
import { TagsCard } from '@/pages/settings/TagsCard';
import { CustomFieldsCard } from '@/pages/settings/CustomFieldsCard';
import { WebhooksCard } from '@/pages/settings/WebhooksCard';
import { ApiTokensCard } from '@/pages/settings/ApiTokensCard';
import { MaintenanceCard } from '@/pages/settings/MaintenanceCard';
import { Profile } from '@/pages/settings/Profile';
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
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<Profile />} />
          <Route path="stages" element={<StagesCard />} />
          <Route path="tags" element={<TagsCard />} />
          <Route path="custom-fields" element={<CustomFieldsCard />} />
          <Route path="webhooks" element={<WebhooksCard />} />
          <Route path="api-tokens" element={<ApiTokensCard />} />
          <Route path="maintenance" element={<MaintenanceCard />} />
        </Route>
        {/*
          Back-compat: anything that bookmarked the old top-level /profile
          (header dropdown links pre-refactor, browser autocompletes) lands
          on the new path without a 404.
        */}
        <Route path="profile" element={<Navigate to="/settings/profile" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
