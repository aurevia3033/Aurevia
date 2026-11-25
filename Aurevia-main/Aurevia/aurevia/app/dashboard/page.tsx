import UserDashboardExperience from '@/components/UserDashboardExperience';

export const dynamic='force-dynamic';

export default function Dashboard(){
  return <div data-section="dashboard"><UserDashboardExperience/></div>;
}
