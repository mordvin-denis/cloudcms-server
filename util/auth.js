var path = require('path');
var fs = require('fs');
var util = require("./util");
var request = require("request");
var http = require("http");
var https = require("https");

exports = module.exports;

// additional methods for Gitana driver
var Gitana = require("gitana");

Gitana.Directory.prototype.findUserForProvider = function(domain, providerId, providerUserId, callback)
{
    var self = this;

    var params = {
        "domainId": domain.getId(),
        "providerId": providerId,
        "providerUserId": providerUserId
    };

    var uriFunction = function()
    {
        return self.getUri() + "/connections/finduser";
    };

    return this.trap(function(err) {
        callback(err);
        return false;
    }).chainPostResponse(this, uriFunction, params).then(function(response) {
        callback(null, response);
    });
};

Gitana.Directory.prototype.createUserForProvider = function(domain, providerId, providerUserId, token, refreshToken, userObject, callback)
{
    var self = this;

    var params = {
        "domainId": domain.getId(),
        "providerId": providerId,
        "providerUserId": providerUserId
    };

    var payload = {
        "user": userObject,
        "token": token,
        "refreshToken": refreshToken
    };

    var uriFunction = function()
    {
        return self.getUri() + "/connections/createuser";
    };

    return this.trap(function(err) {
        callback(err);
        return false;
    }).chainPostResponse(this, uriFunction, params, payload).then(function(response) {
        callback(null, response);
    });
};

var directory = function(domain, callback)
{
    Chain(domain.getPlatform()).readDirectory(domain.defaultDirectoryId).then(function() {
        callback.call(this);
    });
};

/**
 * Loads a user from Cloud CMS for the given connection token and secret.
 *
 * @type {Function}
 */
var findUserForProvider = exports.findUserForProvider = function(domain, providerId, providerUserId, callback)
{
    directory(domain, function() {

        // THIS = directory

        this.findUserForProvider(domain, providerId, providerUserId, function(err, response) {

            if (err)
            {
                return callback(err);
            }

            if (!response.user)
            {
                // nothing found
                return callback();
            }

            // read the user
            Chain(domain).readPrincipal(response.user._doc).then(function() {
                callback(null, this);
            });

        });

    });
};

/**
 * Loads a user from Cloud CMS for the given connection token and secret.
 *
 * @type {Function}
 */
var updateUserForProvider = exports.updateUserForProvider = function(domain, providerId, providerUserId, token, refreshToken, userObject, callback)
{
    findUserForProvider(domain, providerId, providerUserId, function(err, user) {

        if (err)
        {
            return callback(err);
        }

        if (!user) {
            return callback();
        }

        if (userObject)
        {
            for (var k in userObject)
            {
                user[k] = userObject[k];
            }
        }

        if (token)
        {
            user.token = token;
        }

        if (refreshToken)
        {
            user.refreshToken = refreshToken;
        }

        user.update().then(function() {
            callback(null, this);
        });
    });
};

/**
 * Automatically registers / creates the user for the user object.
 *
 * @param req
 * @param providerId
 * @param providerUserId
 * @param userObject
 * @param token
 * @param userObject
 * @param callback
 */
var createUserForProvider = exports.createUserForProvider = function(domain, providerId, providerUserId, token, refreshToken, userObject, callback)
{
    directory(domain, function() {

        // THIS = directory

        this.createUserForProvider(domain, providerId, providerUserId, token, refreshToken, userObject, function(err, data) {

            if (err)
            {
                return callback(err);
            }

            // read the user back
            Chain(domain).readPrincipal(data.user._doc).then(function() {

                callback(null, this);
            });
        });
    });
};

var buildPassportCallback = exports.buildPassportCallback = function(providerId, provider)
{
    return function(req, token, refreshToken, profile, done)
    {
        var info = {};
        info.providerId = providerId;
        info.providerUserId = provider.profileIdentifier(profile);
        info.token = token;
        info.refreshToken = refreshToken;

        done(null, profile, info);
    };
};

/**
 * Ensures that the given user exists in Cloud CMS.
 *
 * @param domain
 * @param providerId
 * @param providerUserId
 * @param token
 * @param refreshToken
 * @param userObject
 * @param callback (err, gitanaUser)
 */
var syncUser = exports.syncUser = function(domain, providerId, providerUserId, token, refreshToken, userObject, callback)
{
    findUserForProvider(domain, providerId, providerUserId, function(err, gitanaUser) {

        if (err) {
            return callback(err);
        }

        // if we already found the user, update it
        if (gitanaUser)
        {
            return updateUserForProvider(domain, providerId, providerUserId, token, refreshToken, userObject, function(err, gitanaUser) {

                if (err) {
                    return callback(err);
                }

                gitanaUser.reload().then(function() {
                    callback(null, this);
                });
            });
        }

        // create
        createUserForProvider(domain, providerId, providerUserId, token, refreshToken, userObject, function(err, gitanaUser) {

            if (err) {
                return callback(err);
            }

            callback(err, gitanaUser);
        });
    });
};

var syncAttachment = exports.syncAttachment = function(gitanaUser, attachmentId, url, callback)
{
    var baseURL = gitanaUser.getDriver().options.baseURL;
    var authorizationHeader = gitanaUser.getDriver().getHttpHeaders()["Authorization"];

    var targetUrl = baseURL + gitanaUser.getUri() + "/attachments/" + attachmentId;

    // add "authorization" for OAuth2 bearer token
    var headers = {};
    headers["Authorization"] = authorizationHeader;

    request.get(url).pipe(request.post({
        url: targetUrl,
        headers: headers
    })).on("response", function(response) {
        callback();
    });
};

var syncProfile = exports.syncProfile = function(req, res, domain, providerId, provider, profile, token, refreshToken, callback)
{
    var userObject = provider.parseProfile(profile);
    var providerConfig = provider.providerConfiguration();
    var providerUserId = provider.profileIdentifier(profile);

    var key = providerId + "-" + providerUserId;

    var _syncUser = function(domain, providerId, providerConfig, providerUserId, token, refreshToken, userObject, callback)
    {
        // do we already have a gitana user?
        findUserForProvider(domain, providerId, providerUserId, function (err, gitanaUser) {

            if (err) {
                return callback(err);
            }

            if (gitanaUser)
            {
                updateUserForProvider(domain, providerId, providerUserId, token, refreshToken, userObject, function (err) {

                    if (err) {
                        return callback(err);
                    }

                    gitanaUser.reload().then(function () {
                        callback(null, this);
                    });
                });
                return;
            }

            if (!providerConfig.autoRegister) {
                return callback();
            }

            createUserForProvider(domain, providerId, providerUserId, token, refreshToken, userObject, function (err, gitanaUser) {

                if (err) {
                    return callback(err);
                }

                callback(null, gitanaUser);
            });

        })
    };

    var _connectUser = function(key, gitanaUser, callback) {

        /*
        var appHelper = Gitana.APPS[key];
        if (appHelper)
        {
            console.log("CONNECT USER LOADED FROM CACHE, APPS");
            return callback(null, appHelper.platform(), appHelper, key);
        }

        var platform = Gitana.PLATFORM_CACHE[key];
        if (platform)
        {
            console.log("CONNECT USER LOADED FROM CACHE, PLATFORM");
            return callback(null, platform, null, key);
        }
        */

        impersonate(req, key, gitanaUser, function(err, platform, appHelper, key) {
            callback(err, platform, appHelper, key);
        });
    };

    _syncUser(domain, providerId, providerConfig, providerUserId, token, refreshToken, userObject, function(err, gitanaUser) {

        if (err) {
            return callback(err);
        }

        // no user found
        if (!gitanaUser) {
            return callback();
        }

        _connectUser(key, gitanaUser, function(err, platform, appHelper, key) {

            if (err) {
                return callback(err);
            }

            callback(err, gitanaUser, platform, appHelper, key);
        });
    });

};

var impersonate = exports.impersonate = function(req, key, targetUser, callback)
{
    // 1. grant "impersonator" role against targetUser for appuser
    // 2. impersonate, get the info
    // 3. revoke "impersonator" role against targetUser

    var authInfo = req.gitana.getDriver().getAuthInfo();
    var currentUserId = authInfo.principalDomainId + "/" + authInfo.principalId;

    var grantImpersonator = function(done)
    {
        Chain(targetUser).trap(function(e) {
            console.log(JSON.stringify(e));
            done();
            return false;
        }).grantAuthority(currentUserId, "impersonator").then(function () {
            done();
        });
    };

    var revokeImpersonator = function(done)
    {
        Chain(targetUser).trap(function(e) {
            done();
            return false;
        }).revokeAuthority(currentUserId, "impersonator").then(function () {
            done();
        });
    };

    var connectImpersonator = function(done)
    {
        var headers = {};
        headers["Authorization"] = req.gitana.platform().getDriver().getHttpHeaders()["Authorization"];

        var agent = http.globalAgent;
        if (process.env.GITANA_PROXY_SCHEME === "https") {
            agent = https.globalAgent;
        }

        var baseURL = process.env.GITANA_PROXY_SCHEME + "://" + process.env.GITANA_PROXY_HOST + ":" + process.env.GITANA_PROXY_PORT;

        request({
            "method": "POST",
            "url": baseURL + "/auth/impersonate/" + targetUser.getDomainId() + "/" + targetUser.getId(),
            "qs": {},
            "json": {},
            "headers": headers,
            "agent": agent,
            "timeout": process.defaultHttpTimeoutMs
        }, function(err, response, json) {

            //var accessToken = json.accessToken;
            //console.log("z.1: " + accessToken);
            //var refreshToken = json.refreshToken;
            var ticket1 = req.gitana.getDriver().getAuthInfo().getTicket();  // TICKET #1
            console.log("z.1: " + ticket1);
            var ticket2 = json.ticket;
            console.log("z.2: " + json.ticket); // TICKET #2

            // connect as the impersonated user
            var x = {
                "clientKey": req.gitanaConfig.clientKey,
                "clientSecret": req.gitanaConfig.clientSecret,
                "ticket": ticket2,
                "baseURL": req.gitanaConfig.baseURL//,
                //"key": key,
                //"appCacheKey": key
            };
            if (req.gitanaConfig.application) {
                x.application = req.gitanaConfig.application;
            }
            Gitana.connect(x, function (err) {

                if (err)
                {
                    console.log("Failed to connect to Cloud CMS: " + JSON.stringify(err));
                    return done(err);
                }

                var ticket3 = this.getDriver().getAuthInfo().getTicket();  // TICKET #1 !!!!!!!!!!!!!!!!!
                console.log("z.3: " + ticket3);

                if (ticket3 == ticket1)
                {
                    console.log("FUDGE");
                }

                var platform = this;
                var appHelper = null;
                if (x.application) {
                    appHelper = this;
                    platform = this.platform();
                }

                done(null, platform, appHelper, key);
            });
        });
    };

    grantImpersonator(function(err) {

        if (err) {
            return revokeImpersonator(function() {
                callback(err);
            });
        }

        connectImpersonator(function(err, platform, appHelper, key) {

            if (err) {
                return revokeImpersonator(function() {
                    callback(err);
                });
            }

            revokeImpersonator(function(err) {

                if (err) {
                    return callback(err);
                }

                callback(null, platform, appHelper, key);
            });
        });
    });
};
