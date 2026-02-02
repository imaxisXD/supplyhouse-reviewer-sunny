import { BrowserRouter, Routes, Route } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Sidebar } from "./components/Sidebar";
import Home from "./pages/Home";
import ReviewStatus from "./pages/ReviewStatus";
import ReviewResults from "./pages/ReviewResults";
import Indexing from "./pages/Indexing";
import Observability from "./pages/Observability";
import Repos from "./pages/Repos";

const RepoGraph = lazy(() => import("./pages/RepoGraph"));

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-white text-ink-950 font-mono antialiased">
        <div className="flex min-h-screen">
          <Sidebar />

          <main className="flex-1 min-w-0 px-6 py-6 lg:px-10">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/review/:id" element={<ReviewStatus />} />
              <Route path="/review/:id/results" element={<ReviewResults />} />
              <Route path="/repos" element={<Repos />} />
              <Route
                path="/repo/:repoId"
                element={
                  <Suspense fallback={<div className="text-ink-600 text-sm">Loading…</div>}>
                    <RepoGraph />
                  </Suspense>
                }
              />
              <Route path="/indexing" element={<Indexing />} />
              <Route path="/observability" element={<Observability />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
