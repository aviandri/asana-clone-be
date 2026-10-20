-- CreateIndex
CREATE INDEX "ApiToken_oauthClientId_idx" ON "ApiToken"("oauthClientId");

-- CreateIndex
CREATE INDEX "OAuthCode_clientId_idx" ON "OAuthCode"("clientId");

-- CreateIndex
CREATE INDEX "OAuthRefresh_clientId_idx" ON "OAuthRefresh"("clientId");

-- CreateIndex
CREATE INDEX "OAuthRequest_clientId_idx" ON "OAuthRequest"("clientId");

