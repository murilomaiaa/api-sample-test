const hubspot = require("@hubspot/api-client");
const axios = require("axios"); // Add axios
const { queue } = require("async");
const _ = require("lodash");

const { filterNullValuesFromObject, goal } = require("./utils");
const Domain = require("./Domain");

const hubspotClient = new hubspot.Client({ accessToken: "" });

const propertyPrefix = "hubspot__";
let expirationDate;

const generateLastModifiedDateFilter = (date, nowDate, propertyName) => {
  const lastModifiedDateFilter = date
    ? {
        filters: [
          { propertyName, operator: "GTE", value: `${date.valueOf()}` },
          { propertyName, operator: "LTE", value: `${nowDate.valueOf()}` },
        ],
      }
    : {};

  return lastModifiedDateFilter;
};

const saveDomain = async (domain) => {
  // disable this for testing purposes
  return;

  domain.markModified("integrations.hubspot.accounts");
  await domain.save();
};

/**
 * Get access token from HubSpot
 */
const refreshAccessToken = async (domain, hubId) => {
  console.log("refresh access token");
  const { HUBSPOT_CID, HUBSPOT_CS } = process.env;
  const account = domain.integrations.hubspot.accounts.find(
    (account) => account.hubId === hubId
  );
  const { accessToken, refreshToken } = account;

  let tryCount = 0;
  while (tryCount < 3) {
    try {
      const result = await hubspotClient.oauth.tokensApi.create(
        "refresh_token",
        undefined,
        undefined,
        HUBSPOT_CID,
        HUBSPOT_CS,
        refreshToken
      );
      console.log("refresh access token success");
      const body = result.body ? result.body : result;

      const newAccessToken = body.accessToken;
      expirationDate = new Date(body.expiresIn * 1000 + new Date().getTime());

      hubspotClient.setAccessToken(newAccessToken);
      if (newAccessToken !== accessToken) {
        account.accessToken = newAccessToken;
      }

      console.log("new access token set to client");
      return true;
    } catch (err) {
      console.log("refresh access token error", err);
      tryCount++;
      if (tryCount >= 3) {
        throw new Error("Failed to refresh access token after 3 attempts");
      }
      console.log(`Retrying refresh access token (${tryCount}/3)`);
    }
  }
};

const getMeetingAttendees = async (meetingId, accessToken) => {
  try {
    console.log('Get meeting attendees:', meetingId);
    const attendeesResponse = await axios.post(
      `https://api.hubapi.com/crm/v3/associations/meetings/contacts/batch/read`,
      { inputs: [{ id: meetingId }] },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const contactIds = attendeesResponse.data.results
      .flatMap(result => result.to)
      .filter(to => to.type === 'meeting_event_to_contact')
      .map(to => ({ id: to.id }));

    if (!contactIds.length) {
      console.log(`No attendees found for meeting ${meetingId}`);
      return [];
    }

    const contactsResponse = await hubspotClient.crm.contacts.batchApi.read({
      inputs: contactIds,
      properties: ['email']
    });

    return contactsResponse.results
      .map(contact => contact.properties?.email)
      .filter(Boolean);

  } catch (error) {
    console.error('Error fetching meeting attendees:', error);
    return [];
  }
};

const processEntities = async (
  domain,
  hubId,
  q,
  entityType,
  properties,
  actionNamePrefix
) => {
  console.log("processEntities", entityType);
  const account = domain.integrations.hubspot.accounts.find(
    (account) => account.hubId === hubId
  );
  const lastPulledDate = account.lastPulledDates[entityType]
    ? new Date(account.lastPulledDates[entityType])
    : undefined;
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    const propertyName =
      entityType === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";
    const lastModifiedDateFilter = generateLastModifiedDateFilter(
      lastModifiedDate,
      now,
      propertyName
    );
    const searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts: [{ propertyName, direction: "ASCENDING" }],
      properties,
      limit,
      after: offsetObject.after,
    };

    let searchResult = {};

    let tryCount = 0;
    while (tryCount <= 4) {
      try {
        console.log("searching", entityType, tryCount);
        if (hubspotClient.crm[entityType]) {
          searchResult = await hubspotClient.crm[entityType].searchApi.doSearch(
            searchObject
          );
        } else {
          // Sdk was not working for meetings
          const response = await axios.post(
            `https://api.hubapi.com/crm/v3/objects/${entityType}/search`,
            searchObject,
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${hubspotClient.config.accessToken}`,
              },
            }
          );
          searchResult = response.data;
        }
        break;
      } catch (err) {
        tryCount++;

        if (new Date() > expirationDate)
          await refreshAccessToken(domain, hubId);

        if (tryCount > 3) {
          console.log(JSON.stringify(searchObject, null, 2));
          console.log(err);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 5000 * Math.pow(2, tryCount))
        );
      }
    }

    if (!searchResult)
      throw new Error(
        `Failed to fetch ${entityType} for the 4th time. Aborting.`
      );

    const data = searchResult.results || [];
    offsetObject.after = parseInt(searchResult.paging?.next?.after);

    console.log(`fetch ${entityType} batch`);

    for (const entity of data) {
      if (!entity.properties) continue;

      const isCreated = new Date(entity.createdAt) > lastPulledDate;

      const entityProperties = properties.reduce((acc, prop) => {
        acc[prop] = entity.properties[prop];
        return acc;
      }, {});

      const actionTemplate = {
        includeInAnalytics: 0,
        [`${entityType}Properties`]:
          filterNullValuesFromObject(entityProperties),
      };

      if (entityType === "meetings") {
        const attendeeEmails = await getMeetingAttendees(
          entity.id,
          hubspotClient.config.accessToken
        );
        actionTemplate.contactEmails = attendeeEmails;
      }

      q.push({
        actionName: isCreated
          ? `${actionNamePrefix} Created`
          : `${actionNamePrefix} Updated`,
        actionDate: new Date(isCreated ? entity.createdAt : entity.updatedAt),
        ...actionTemplate,
      });
    }

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(
        data[data.length - 1].updatedAt
      ).valueOf();
    }
  }

  account.lastPulledDates[entityType] = now;
  await saveDomain(domain);

  return true;
};

const processContacts = (domain, hubId, q) => {
  return processEntities(
    domain,
    hubId,
    q,
    "contacts",
    [
      "firstname",
      "lastname",
      "jobtitle",
      "email",
      "hubspotscore",
      "hs_lead_status",
      "hs_analytics_source",
      "hs_latest_source",
    ],
    "Contact"
  );
};

const processCompanies = (domain, hubId, q) => {
  return processEntities(
    domain,
    hubId,
    q,
    "companies",
    [
      "name",
      "domain",
      "country",
      "industry",
      "description",
      "annualrevenue",
      "numberofemployees",
      "hs_lead_status",
    ],
    "Company"
  );
};

const processMeetings = (domain, hubId, q) => {
  return processEntities(
    domain,
    hubId,
    q,
    "meetings",
    [
      "hs_meeting_title",
      "createdAt",
      "updatedAt",
      "hs_meeting_start_time",
      "hs_meeting_end_time",
    ],
    "Meeting"
  );
};

const createQueue = (domain, actions) =>
  queue(async (action, callback) => {
    console.log('Handle queue action:', action);
    actions.push(action);

    if (actions.length > 2000) {
      console.log("inserting actions to database", {
        apiKey: domain.apiKey,
        count: actions.length,
      });

      const copyOfActions = _.cloneDeep(actions);
      actions.splice(0, actions.length);

      await goal(copyOfActions);
    }

    callback();
  }, 100000000);

const drainQueue = async (domain, actions, q) => {
  console.log("drain queue", `actions.length ${actions.length}`, `q.length() ${q.length()}`);
  if (q.length() > 0) await q.drain();

  if (actions.length > 0) {
    await goal(actions);
  }

  return true;
};

const pullDataFromHubspot = async () => {
  console.log("start pulling data from HubSpot");

  const domain = await Domain.findOne({});

  for (const account of domain.integrations.hubspot.accounts) {
    console.log("start processing account");

    try {
      await refreshAccessToken(domain, account.hubId);
      console.log("refresh access token");
    } catch (err) {
      console.log(err, {
        apiKey: domain.apiKey,
        metadata: { operation: "refreshAccessToken" },
      });
    }

    const actions = [];
    console.log("create queue");
    console.log(domain, actions);
    const q = createQueue(domain, actions);
    console.log("q.length()", q.length());

    try {
      await processContacts(domain, account.hubId, q);
      console.log("process contacts");
    } catch (err) {
      console.log(err, {
        apiKey: domain.apiKey,
        metadata: { operation: "processContacts", hubId: account.hubId },
      });
    }

    try {
      await processCompanies(domain, account.hubId, q);
      console.log("process companies");
    } catch (err) {
      console.log(err, {
        apiKey: domain.apiKey,
        metadata: { operation: "processCompanies", hubId: account.hubId },
      });
    }

    try {
      await processMeetings(domain, account.hubId, q);
      console.log("process meetings");
    } catch (err) {
      console.log(err, {
        apiKey: domain.apiKey,
        metadata: { operation: "processMeetings", hubId: account.hubId },
      });
    }

    try {
      await drainQueue(domain, actions, q);
      console.log("drain queue");
    } catch (err) {
      console.log(err, {
        apiKey: domain.apiKey,
        metadata: { operation: "drainQueue", hubId: account.hubId },
      });
    }

    await saveDomain(domain);

    console.log("finish processing account");
  }

  process.exit();
};

module.exports = pullDataFromHubspot;
