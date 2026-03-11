import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { Search } from "./pages/Search";

// Lazy-load pages that aren't the landing route
const MemoryDetail = lazy(() => import("./pages/MemoryDetail").then((m) => ({ default: m.MemoryDetail })));
const Dashboard = lazy(() => import("./pages/Sources").then((m) => ({ default: m.Dashboard })));
const Entities = lazy(() => import("./pages/Entities").then((m) => ({ default: m.Entities })));
const EntityDetail = lazy(() => import("./pages/EntityDetail").then((m) => ({ default: m.EntityDetail })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Trash = lazy(() => import("./pages/Trash").then((m) => ({ default: m.Trash })));
const Graph = lazy(() => import("./pages/Graph").then((m) => ({ default: m.Graph })));
const Goals = lazy(() => import("./pages/Goals").then((m) => ({ default: m.Goals })));
const Chat = lazy(() => import("./pages/Chat").then((m) => ({ default: m.Chat })));
const Skills = lazy(() => import("./pages/Skills").then((m) => ({ default: m.Skills })));
const Analytics = lazy(() => import("./pages/Analytics").then((m) => ({ default: m.Analytics })));
const Timeline = lazy(() => import("./pages/Timeline").then((m) => ({ default: m.Timeline })));
const Library = lazy(() => import("./pages/Library").then((m) => ({ default: m.Library })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function PageFallback() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 200 }}>
      <div style={{ color: "#8080a0", fontSize: 14 }}>Loading...</div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Search />} />
                <Route path="/memory/:id" element={<MemoryDetail />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/entities" element={<Entities />} />
                <Route path="/entities/:id" element={<EntityDetail />} />
                <Route path="/graph" element={<Graph />} />
                <Route path="/goals" element={<Goals />} />
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/timeline" element={<Timeline />} />
                <Route path="/library" element={<Library />} />
                <Route path="/skills" element={<Skills />} />
                <Route path="/trash" element={<Trash />} />

                <Route path="/chat" element={<Chat />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<div style={{ padding: 40 }}><h1 style={{ color: "#e8e8f4", fontSize: 22 }}>Page not found</h1><p style={{ color: "#8080a0" }}>The page you're looking for doesn't exist.</p></div>} />
              </Route>
            </Routes>
          </Suspense>
          </ErrorBoundary>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
