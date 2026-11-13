import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { BottomNav } from "./components/BottomNav";
import { AccountPage } from "./pages/AccountPage";
import { SongPage } from "./pages/SongPage";
import { SongsPage } from "./pages/SongsPage";

function LibraryLayout() {
  return (
    <div className="app-shell">
      <div className="screen">
        <Outlet />
      </div>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<LibraryLayout />}>
        <Route path="/" element={<Navigate to="/songs" replace />} />
        <Route path="/songs" element={<SongsPage />} />
        <Route path="/account" element={<AccountPage />} />
      </Route>
      <Route path="/songs/:id" element={<SongPage />} />
      <Route path="*" element={<Navigate to="/songs" replace />} />
    </Routes>
  );
}
