import { useCallback, useEffect, useMemo } from "react";
import tmi, { ChatUserstate } from "tmi.js";

import { ambassadors, AmbassadorKey } from "../utils/ambassadors";
import { typeSafeObjectEntries } from "../utils/helpers";

import useChannel from "./useChannel";

const testChannelNames =
  process.env.REACT_APP_TEST_CHANNEL_NAMES?.split(",") ?? [];
const defaultChannelNames =
  process.env.REACT_APP_DEFAULT_CHANNEL_NAMES?.split(",") ?? [];
const extraChannelNames =
  process.env.REACT_APP_EXTRA_CHANNEL_NAMES?.split(",") ?? [];
const privilegedUsers =
  process.env.REACT_APP_CHAT_COMMANDS_PRIVILEGED_USERS?.split(",") ?? [];

export const normalizeAmbassadorName = (
  name: string,
  stripDiacritic = false,
): string => {
  const first = name.split(" ")[0].toLowerCase();
  return stripDiacritic
    ? first.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    : first;
};

/**
 * @description Creates a map of ambassador names to their keys, for chat commands.
 *
 * Some ambassadors have names with diacritics in them (Ex: Jalapeño), so this function
 * also maps normalized names to their original names. (Ex: jalapeno -> jalapeño)
 */
const getAmbassadorCommandsMap = (): Map<string, AmbassadorKey> => {
  const commandMap = new Map<string, AmbassadorKey>();
  typeSafeObjectEntries(ambassadors).forEach(([key, ambassador]) => {
    // Always add the original name to the map
    const normalizedWithDiacritics = normalizeAmbassadorName(ambassador.name);
    commandMap.set(normalizedWithDiacritics, key);

    // If the ambassador has a diacritic in their name, add the normalized name to the map
    const normalizedWithoutDiacritics = normalizeAmbassadorName(
      ambassador.name,
      true,
    );
    if (normalizedWithDiacritics !== normalizedWithoutDiacritics)
      commandMap.set(normalizedWithoutDiacritics, key);
  });
  return commandMap;
};

export default function useChatCommand(callback: (command: string) => void) {
  const channel = useChannel();
  const channelNames = useMemo(
    () =>
      Array.from(
        new Set(
          [
            // Always connect to any test channels, for development.
            ...testChannelNames,
            // If we know what channel we're in, connect to it.
            // Otherwise, connect to the default channels.
            ...(channel ? [channel] : defaultChannelNames),
            // If we're not in a default channel, connect to the extra channels.
            // Extra channels are used for mod control during collaborations,
            //  so we don't need to connect to them if we're in a default channel.
            ...(channel && !defaultChannelNames.includes(channel)
              ? extraChannelNames
              : []),
          ].map((name) => name.toLowerCase()),
        ),
      ),
    [channel],
  );

  const commandsMap = useMemo(() => {
    const commands = getAmbassadorCommandsMap() as Map<string, string>;
    commands.set("welcome", "welcome");
    return commands;
  }, []);

  const messageHandler = useCallback(
    (
      id: number,
      channel: string,
      tags: ChatUserstate,
      msg: string,
      self: boolean,
    ) => {
      // Ignore if user is not a moderator or broadcaster or test user
      if (
        !tags.mod &&
        !tags.badges?.broadcaster &&
        !privilegedUsers.includes(tags.username ?? "")
      )
        return;
      // Ignore echoed messages (messages sent by the bot) and messages that don't start with '!'
      if (self || !msg.trim().startsWith("!")) return;

      const commandName = msg.trim().toLowerCase().slice(1);
      const command = commandsMap.get(commandName);
      console.log(
        `*Twitch extension received command: ${commandName} (${command})*`,
        id,
      );
      if (command) callback(command);
    },
    [commandsMap, callback],
  );

  useEffect(() => {
    const id = Date.now();
    console.log("*Twitch extension is connecting to chat*", id);

    // Create the client
    const client = new tmi.Client({
      connection: {
        secure: true,
        reconnect: true,
      },
      channels: channelNames.map((name) => `#${name}`),
    });

    // Handle incoming messages
    client.on("message", (...args) => messageHandler(id, ...args));

    // Handle race condition where we connect after being unmounted
    let closing = false;
    client.on("connected", () => {
      // If we connected after being unmounted, disconnect (again)
      if (closing) {
        client
          .disconnect()
          .then(() =>
            console.log(
              "*Twitch extension disconnected from chat (after connecting)*",
              id,
            ),
          );
        return;
      }

      console.log(
        `*Twitch extension is connected to chat: ${channelNames.join(", ")}*`,
        id,
      );
    });

    // Connect to chat
    client.connect();

    // Disconnect from chat when unmounting
    return () => {
      closing = true;
      client
        .disconnect()
        .then(() =>
          console.log("*Twitch extension disconnected from chat*", id),
        );
    };
  }, [channelNames, messageHandler]);
}
