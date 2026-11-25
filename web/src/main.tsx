import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/Shell";
import { HealthPage } from "@/pages/Health";
import { JobDetail } from "@/pages/JobDetail";
import { Jobs } from "@/pages/Jobs";
import { Overview } from "@/pages/Overview";
import { Settings } from "@/pages/Settings";
import { Setup } from "@/pages/Setup";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <HashRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:id" element={<JobDetail />} />
            <Route path="projects" element={<Navigate to="/settings" replace />} />
            <Route path="health" element={<HealthPage />} />
            <Route path="settings" element={<Settings />} />
            <Route path="setup" element={<Setup />} />
          </Route>
        </Routes>
      </HashRouter>
    </TooltipProvider>
  </StrictMode>,
);
