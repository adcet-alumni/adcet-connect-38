import MailComposer from "nodemailer/lib/mail-composer/index.js";
const m = new MailComposer({from: "a@b.com", to: "c@d.com", subject: "test", text: "hello"});
m.compile().build().then(b => console.log(b.toString()));
