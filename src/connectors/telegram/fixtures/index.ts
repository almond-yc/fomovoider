import me from "./me.json";
import dialogs from "./dialogs.json";
import historyBob from "./history-bob.json";
import historyBookClub from "./history-book-club.json";
import peerDialogsBob from "./peer-dialogs-bob.json";
import sendUser from "./send-user.json";
import sendChannel from "./send-channel.json";
import loginToken from "./login-token.json";
import loginTokenSuccess from "./login-token-success.json";
import sentCode from "./sent-code.json";
import authorization from "./authorization.json";
import password from "./password.json";

export const fixtures = {
  "me": me,
  "dialogs": dialogs,
  "history-bob": historyBob,
  "history-book-club": historyBookClub,
  "peer-dialogs-bob": peerDialogsBob,
  "send-user": sendUser,
  "send-channel": sendChannel,
  "login-token": loginToken,
  "login-token-success": loginTokenSuccess,
  "sent-code": sentCode,
  "authorization": authorization,
  "password": password,
};

export type FixtureName = keyof typeof fixtures;
