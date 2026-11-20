import express from 'express';
import asyncHandler from 'express-async-handler';
import { receiveWebhook, verifyWebhook } from '../controllers/metaLeadsController.js';

// /api/meta/webhook — called by Meta, not by the app: NO login. GET is Meta's set-up check (verify token), POST carries new Lead Ads
// leads and is accepted only with Meta's signature over the raw body. server.js mounts this BEFORE the JSON body parser (with
// express.raw), and before /api/meta (whose login check would refuse Meta).
const router = express.Router();
router.get('/', verifyWebhook);
router.post('/', asyncHandler(receiveWebhook));

export default router;
