/**
 * Agency staff — /api/companies/:company_id/recruitment
 *
 * Admins and managers of the agency company. Plan gate (recruitment.manage)
 * is mounted in server.js with allowReads, so a lapsed plan still opens the
 * pipeline it already has.
 */
const express = require("express");
const multer = require("multer");
const router = express.Router({ mergeParams: true });

const verifyToken = require("../../middleware/verifyToken");
const validateTenant = require("../../middleware/validateTenant");
const { isManager } = require("../../middleware/authorizeRoles");
const { AgencyController: C } = require("../../controller/Recruitment/recruitmentController");

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.use(verifyToken, validateTenant, isManager);

router.get("/agency", C.getAgency);
router.put("/agency", C.saveAgency);
router.post("/agency/logo", logoUpload.single("logo"), C.uploadLogo);
router.delete("/agency/logo", C.removeLogo);
router.get("/overview", C.overview);
router.get("/form-catalog", C.formCatalog);

router.get("/clients", C.listClients);
router.post("/clients", C.createClient);
router.get("/clients/:id", C.getClient);
router.put("/clients/:id", C.updateClient);
router.post("/clients/:id/users", C.createClientUser);
router.put("/client-users/:userId", C.updateClientUser);

router.get("/jobs", C.listJobs);
router.post("/jobs", C.createJob);
router.get("/jobs/:id", C.getJob);
router.put("/jobs/:id", C.updateJob);
router.get("/jobs/:id/applications", C.listApplications);

router.post("/applications/share", C.shareApplications);
router.patch("/applications/:appId", C.updateApplication);
router.get("/applications/:appId/cv", C.downloadCv);

module.exports = router;
