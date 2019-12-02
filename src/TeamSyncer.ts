import { Logging } from "matrix-appservice-bridge";
import { BridgedRoom } from "./BridgedRoom";
import { Main } from "./Main";
import { ConversationsInfoResponse, UsersInfoResponse, ConversationsListResponse, ConversationsInfo,
    UsersListResponse, ConversationsMembersResponse } from "./SlackResponses";
import { WebClient } from "@slack/web-api";
import PQueue from "p-queue";
import { ISlackUser } from "./BaseSlackHandler";

const log = Logging.get("TeamSyncer");

export interface ITeamSyncConfig {
    enabled: boolean;
    channels?: {
        whitelist?: string[];
        blacklist?: string[];
        alias_prefix?: string;
    };
}

const TEAM_SYNC_CONCURRENCY = 1;
const TEAM_SYNC_CHANNEL_CONCURRENCY = 2;
const TEAM_SYNC_MIN_WAIT = 5000;
const TEAM_SYNC_MAX_WAIT = 15000;
const TEAM_SYNC_FAILSAFE = 10;

/**
 * This class handles syncing slack teams to Matrix.
 */
export class TeamSyncer {
    private teamConfigs: {[teamId: string]: ITeamSyncConfig} = {};
    constructor(private main: Main) {
        const config = main.config;
        if (!config.team_sync) {
            throw Error("team_sync is not defined in the config");
        }
        for (const team of Object.keys(config.team_sync)) {
            if (!config.team_sync[team].enabled) {
                log.warn(`Team ${team} is disabled in the config`);
                return;
            }
            this.teamConfigs[team] = config.team_sync[team];
        }
    }

    public async syncAllTeams(teamClients: { [id: string]: WebClient; }) {
        const queue = new PQueue({concurrency: TEAM_SYNC_CONCURRENCY});
        for (const [teamId, client] of Object.entries(teamClients)) {
            if (!this.getTeamSyncConfig(teamId)) {
                log.debug(`Not syncing ${teamId}, team is not configured to sync`);
                continue;
            }
            // tslint:disable-next-line: no-floating-promises
            queue.add((async () => {
                log.info("Syncing team", teamId);
                await this.syncItems(teamId, client, "user");
                await this.syncItems(teamId, client, "channel");
            }));
        }
        try {
            log.info("Waiting for all teams to sync");
            await queue.onIdle();
            log.info("All teams have synced");
        } catch (ex) {
            log.error("There was an issue when trying to sync teams:", ex);
        }
    }

    public async syncItems(teamId: string, client: WebClient, type: "user"|"channel") {
        if (!this.getTeamSyncConfig(teamId, type)) {
            return;
        }
        // tslint:disable-next-line: no-any
        let itemList: any[] = [];
        let cursor: string|undefined;
        for (let i = 0; i < TEAM_SYNC_FAILSAFE && (cursor === undefined || cursor !== ""); i++) {
            let res: ConversationsListResponse|UsersListResponse;
            if (type === "channel") {
                res = (await client.conversations.list({
                    limit: 1000,
                    exclude_archived: true,
                    type: "public_channel",
                    cursor,
                })) as ConversationsListResponse;
                itemList = itemList.concat(res.channels);
            } else {
                res = (await client.users.list({
                    limit: 1000,
                    cursor,
                })) as UsersListResponse;
                itemList = itemList.concat(res.members);
            }

            cursor = res.response_metadata.next_cursor;
            if (cursor !== "") {
                const ms = Math.min(TEAM_SYNC_MIN_WAIT, Math.random() * TEAM_SYNC_MAX_WAIT);
                log.info(`Waiting ${ms}ms before returning more rows`);
                await new Promise((r) => setTimeout(
                    r,
                    ms,
                ));
            }
        }
        const queue = new PQueue({concurrency: TEAM_SYNC_CHANNEL_CONCURRENCY});
        log.info(`Found ${itemList.length} total ${type}s`);
        const team = await this.main.datastore.getTeam(teamId);
        if (!team || !team.domain) {
            throw Error("No team domain!");
        }
        for (const item of itemList) {
            if (type === "channel") {
                // tslint:disable-next-line: no-floating-promises
                queue.add(() => this.syncChannel(teamId, item));
            } else {
                // tslint:disable-next-line: no-floating-promises
                queue.add(() => this.syncUser(teamId, team.domain, item));
            }
        }
        await queue.onIdle();
    }

    private getTeamSyncConfig(teamId: string, item?: "channel"|"user", itemId?: string) {
        const teamConfig = this.teamConfigs[teamId] || this.teamConfigs.all;
        if (!teamConfig) {
            return false;
        }
        if (!teamConfig.enabled) {
            return false;
        }
        const channels = teamConfig.channels;
        if (item === "channel" && channels && itemId) {
            if (channels.blacklist) {
                if (channels.blacklist.includes(itemId)) {
                    log.warn("Not bridging channel, blacklisted");
                    return false;
                }
            }
            if (channels.whitelist) {
                if (!channels.whitelist.includes(itemId)) {
                    log.warn("Not bridging channel, not in whitelist");
                    return false;
                }
            }
        }
        // More granular please.
        return teamConfig;
    }

    public async onChannelAdded(teamId: string, channelId: string, name: string, creator: string) {
        // Should create the channel?
        log.info(`${teamId} created channel ${channelId}`);
        const existingChannel = this.main.rooms.getBySlackChannelId(channelId);
        if (existingChannel) {
            log.info("Channel already exists in datastore, not bridging");
            return;
        }
        const client = await this.main.clientFactory.getTeamClient(teamId);
        const { channel } = (await client.conversations.info({ channel: channelId })) as ConversationsInfoResponse;
        if (!channel.is_channel || channel.is_private) {
            log.warn("Not creating channel: Is either private or not a channel");
            return;
        }
        await this.syncChannel(teamId, channel);
    }

    public async onDiscoveredPrivateChannel(teamId: string, client: WebClient, chanInfo: ConversationsInfoResponse) {
        log.info(`Discovered private channel ${teamId} ${chanInfo.channel.id}`);
        const channelItem = chanInfo.channel;
        if (!this.getTeamSyncConfig(teamId, "channel", channelItem.id)) {
            log.info(`Not syncing`);
            return;
        }
        const existingChannel = this.main.rooms.getBySlackChannelId(channelItem.id);
        if (existingChannel) {
            log.debug("Channel already exists in datastore, not bridging");
            return;
        }
        if (channelItem.is_im || channelItem.is_mpim || !channelItem.is_private) {
            log.warn("Not creating channel: Is not a private channel");
            return;
        }
        log.info(`Attempting to dynamically bridge private ${channelItem.id} ${channelItem.name}`);
        // Create the room first.
        try {
            const members = await this.mapChannelMembershipToMatrixIds(teamId, client, channelItem.id);
            const roomId = await this.createRoomForChannel(teamId, channelItem.creator, channelItem, false, members);
            const inboundId = this.main.genInboundId();
            const room = new BridgedRoom(this.main, {
                inbound_id: inboundId,
                matrix_room_id: roomId,
                slack_team_id: teamId,
                slack_channel_id: channelItem.id,
                is_private: true,
            }, undefined, undefined);
            room.updateUsingChannelInfo(chanInfo);
            this.main.rooms.upsertRoom(room);
            await this.main.datastore.upsertRoom(room);
        } catch (ex) {
            log.error("Failed to provision new room dynamically:", ex);
        }
    }

    public async syncUser(teamId: string, domain: string, item: ISlackUser) {
        log.info(`Syncing user ${teamId} ${item.id}`);
        const slackGhost = await this.main.getGhostForSlack(item.id, domain, teamId);
        if (item.deleted !== true) {
            await slackGhost.updateFromISlackUser(item);
            return;
        }
        log.warn(`User ${item.id} has been deleted`);
        await slackGhost.intent.setDisplayName("Deleted User");
        await slackGhost.intent.setAvatarUrl(undefined);
        // XXX: We *should* fetch the rooms the user is actually in rather
        // than just removing it from every room. However, this is quicker to
        // implement.
        log.info("Leaving from all rooms");
        let i = this.main.rooms.all.length;
        await Promise.all(this.main.rooms.all.map((r) =>
            slackGhost.intent.leave(r.MatrixRoomId).catch((ex) => {
                i--;
                // Failing to leave a room is fairly normal.
            }),
        ));
        log.info(`Left ${i} rooms`);
        return;
    }

    private async syncChannel(teamId: string, channelItem: ConversationsInfo) {
        log.info(`Syncing channel ${teamId} ${channelItem.id}`);
        if (!this.getTeamSyncConfig(teamId, "channel", channelItem.id)) {
            log.info(`Not syncing channel because it has been disallowed.`);
            return;
        }
        const client = await this.main.clientFactory.getTeamClient(teamId);
        const existingChannel = this.main.rooms.getBySlackChannelId(channelItem.id);
        if (existingChannel) {
            log.debug("Channel already exists in datastore, not bridging");
            return;
        }
        if (!channelItem.is_channel || channelItem.is_private) {
            log.warn("Not creating channel: Is either private or not a channel");
            return;
        }
        log.info(`Attempting to dynamically bridge ${channelItem.id} ${channelItem.name}`);
        const userId = (await this.main.datastore.getTeam(teamId))!.user_id;
        const {user} = (await client.users.info({ user: userId })) as UsersInfoResponse;
        try {
            const creatorClient = await this.main.clientFactory.getClientForSlackUser(teamId, channelItem.creator);
            if (!creatorClient) {
                throw Error("no-client");
            }
            await creatorClient.client.conversations.invite({
                users: userId,
                channel: channelItem.id,
            });
        } catch (ex) {
            log.warn("Couldn't invite bot to channel", ex);
            try {
                await client.chat.postEphemeral({
                    user: channelItem.creator,
                    text: `Hint: To bridge to Matrix, run the \`/invite @${user!.name}\` command in this channel.`,
                    channel: channelItem.id,
                });
            } catch (ex) {
                log.warn("Couldn't send a notice either");
            }
        }

        // Create the room first.
        try {
            const roomId = await this.createRoomForChannel(teamId, channelItem.creator, channelItem);
            await this.main.actionLink({
                matrix_room_id: roomId,
                slack_channel_id: channelItem.id,
                team_id: teamId,
            });
        } catch (ex) {
            log.error("Failed to provision new room dynamically:", ex);
        }
    }

    public async onChannelDeleted(teamId: string, channelId: string) {
        log.info(`${teamId} removed channel ${channelId}`);
        if (!this.getTeamSyncConfig(teamId, "channel", channelId)) {
            return;
        }
        const room = this.main.rooms.getBySlackChannelId(channelId);
        if (!room) {
            log.warn("Not unlinking channel, no room found");
            return;
        }

        try {
            await this.main.botIntent.sendMessage(room.MatrixRoomId, {
                msgtype: "m.notice",
                body: "The Slack channel bridged to this room has been deleted.",
            });
        } catch (ex) {
            log.warn("Failed to send deletion notice into the room:", ex);
        }

        // Hide deleted channels in the room directory.
        try {
            await this.main.botIntent.getClient().setRoomDirectoryVisibility(room.MatrixRoomId, "private");
        } catch (ex) {
            log.warn("Failed to hide room from the room directory:", ex);
        }

        try {
            await this.main.actionUnlink({ matrix_room_id: room.MatrixRoomId });
        } catch (ex) {
            log.warn("Tried to unlink room but failed:", ex);
        }
    }

    public async onTeamMemberJoined(teamId: string, user: any) {
        log.info(`${teamId} added user ${user}`);
    }

    public async onUserChange(teamId: string, user: any) {
        log.info(`${teamId} added user ${user}`);
    }

    private getAliasPrefix(teamId: string) {
        const channelConfig = this.getTeamSyncConfig(teamId);
        if (channelConfig === false || channelConfig.channels === undefined) {
            return;
        }
        return channelConfig.channels.alias_prefix;
    }

    private async createRoomForChannel(teamId: string, creator: string, channel: ConversationsInfo,
                                       isPublic: boolean = true, inviteList: string[] = []): Promise<string> {
        let intent;
        let creatorUserId: string|undefined;
        try {
            creatorUserId = (await this.main.getGhostForSlack(creator, undefined, teamId)).userId;
            intent = this.main.getIntent(creatorUserId);
        } catch (ex) {
            // Couldn't get the creator's mxid, using the bot.
            intent = this.main.botIntent;
        }
        const aliasPrefix = this.getAliasPrefix(teamId);
        const alias = aliasPrefix ? `${aliasPrefix}${channel.name.toLowerCase()}` : undefined;
        let topic: undefined|string;
        if (channel.purpose) {
            topic = channel.purpose.value;
        }
        log.debug("Creating new room for channel", channel.name, topic, alias);
        const plUsers = {};
        plUsers[this.main.botUserId] = 100;
        if (creatorUserId) {
            plUsers[creatorUserId] = 100;
        }
        inviteList = inviteList.filter((s) => s !== creatorUserId || s !== this.main.botUserId);
        inviteList.push(this.main.botUserId);
        const {room_id} = await intent.createRoom({
            createAsClient: true,
            options: {
                name: `#${channel.name}`,
                topic,
                visibility: isPublic ? "public" : "private",
                room_alias: alias,
                preset: isPublic ? "public_chat" : "private_chat",
                invite: inviteList,
                initial_state: [{
                    content: {
                        users: plUsers,
                        users_default: 0,
                        events: {
                            "m.room.name": 50,
                            "m.room.power_levels": 100,
                            "m.room.history_visibility": 100,
                            "m.room.encryption": 100,
                            "m.room.canonical_alias": 50,
                            "m.room.avatar": 50,
                        },
                        events_default: 0,
                        state_default: 50,
                        ban: 50,
                        kick: 50,
                        redact: 50,
                        invite: 0,
                    },
                    state_key: "",
                    type: "m.room.power_levels",
                }],
            },
        });
        log.info("Created new room for channel:", room_id);
        return room_id;
    }

    private async mapChannelMembershipToMatrixIds(teamId: string, webClient: WebClient, channelId: string) {
        const team = await this.main.datastore.getTeam(teamId);
        if (!team || !team.domain) {
            throw Error("No team domain!");
        }
        const memberset: Set<string> = new Set();
        let cursor: string|undefined;
        while (cursor !== "") {
            const membersRes = (await webClient.conversations.members({
                channel: channelId, limit: 1000, cursor,
            })) as ConversationsMembersResponse;
            membersRes.members.forEach(memberset.add.bind(memberset));
            cursor = membersRes.response_metadata.next_cursor;
        }
        const matrixIds: string[] = [];
        for (const member of memberset) {
            const mxid = await this.main.datastore.getPuppetMatrixUserBySlackId(teamId, member);
            if (mxid) {
                matrixIds.push(mxid);
            }
        }
        return matrixIds;
    }
}