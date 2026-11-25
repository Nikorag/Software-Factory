import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/Shell";
import { loadToken } from "@/lib/api";
import { HealthPage } from "@/pages/Health";
import { JobDetail } from "@/pages/JobDetail";
import { Jobs } from "@/pages/Jobs";
import { Overview } from "@/pages/Overview";
import { Projects } from "@/pages/Projects";
import "./index.css";

loadToken(); // before the router reads the hash: the token arrives as #token=… and is removed from the URL immediately

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <HashRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:id" element={<JobDetail />} />
            <Route path="projects" element={<Projects />} />
            <Route path="health" element={<HealthPage />} />
          </Route>
        </Routes>
      </HashRouter>
    </TooltipProvider>
  </StrictMode>,
);
