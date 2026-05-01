export function buildAutoAckHtml(ticketRef: string): string {
  return `<p>Hello,</p>
<p>Thank you for reaching out to Plumtrips. We have received your request and our team is reviewing it.</p>
<p><strong>Your ticket reference is: ${ticketRef}</strong></p>
<p>Please reference this number in any follow-up. We will respond to you shortly.</p>
<p>Warm regards,<br>Plumtrips Concierge<br>
<a href="https://plumtrips.com">plumtrips.com</a></p>`;
}
