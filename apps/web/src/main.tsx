import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createProfileApi, createSelfEvaluationReviewApi } from "./api/client.js";
import { ProfilePage } from "./profile/ProfilePage.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <ProfilePage api={createProfileApi()} reviewApi={createSelfEvaluationReviewApi()} />
  </StrictMode>
);
