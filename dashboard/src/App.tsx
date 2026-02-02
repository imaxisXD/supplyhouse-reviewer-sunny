import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { lazy, Suspense } from "react";
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
      <div className="min-h-screen bg-gray-950 text-gray-100">
        <nav className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-14">
              <Link to="/" className="text-lg font-semibold text-white tracking-tight">
                PR Reviewer
              </Link>
              <div className="flex gap-6">
                <Link to="/" className="text-sm text-gray-400 hover:text-white transition-colors">
                  Review
                </Link>
                <Link to="/repos" className="text-sm text-gray-400 hover:text-white transition-colors">
                  Repos
                </Link>
                <Link to="/indexing" className="text-sm text-gray-400 hover:text-white transition-colors">
                  Indexing
                </Link>
                <Link to="/observability" className="text-sm text-gray-400 hover:text-white transition-colors">
                  Observability
                </Link>
              </div>
            </div>
          </div>
        </nav>
        <Routes>
          <Route path="/repo/:repoId" element={<Suspense fallback={null}><RepoGraph /></Suspense>} />
          <Route
            path="*"
            element={
              <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/review/:id" element={<ReviewStatus />} />
                  <Route path="/review/:id/results" element={<ReviewResults />} />
                  <Route path="/repos" element={<Repos />} />
                  <Route path="/indexing" element={<Indexing />} />
                  <Route path="/observability" element={<Observability />} />
                </Routes>
              </main>
            }
          />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
