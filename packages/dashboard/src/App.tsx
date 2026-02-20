import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./components/Toast";
import { Layout } from "./components/Layout";
import { Search } from "./pages/Search";
import { Timeline } from "./pages/Timeline";
import { MemoryDetail } from "./pages/MemoryDetail";
import { Dashboard } from "./pages/Sources";
import { Entities } from "./pages/Entities";
import { EntityDetail } from "./pages/EntityDetail";
import { Settings } from "./pages/Settings";
import { Trash } from "./pages/Trash";
import { Graph } from "./pages/Graph";
import { Goals } from "./pages/Goals";
import { Chat } from "./pages/Chat";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Search />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="/memory/:id" element={<MemoryDetail />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/entities" element={<Entities />} />
              <Route path="/entities/:id" element={<EntityDetail />} />
              <Route path="/graph" element={<Graph />} />
              <Route path="/goals" element={<Goals />} />
              <Route path="/trash" element={<Trash />} />

              <Route path="/chat" element={<Chat />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
