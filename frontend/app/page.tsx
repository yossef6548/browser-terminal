import dynamic from 'next/dynamic';

const TerminalPage = dynamic(() => import('../components/TerminalPage'), {
  ssr: false
});

export default function Page() {
  return <TerminalPage />;
}