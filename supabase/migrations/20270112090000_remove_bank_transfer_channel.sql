-- Remove Paystack "bank transfer" as a selectable channel.
-- Checkout always charges in KES, where bank transfer is not a working Paystack channel.
--  1. Strip it from every stored provider setting, so it is no longer listed to clients and
--     payments_checkout_prepare (which requires the channel to be enabled in settings) refuses it.
--  2. Stop payments_set_paystack_options from enabling it again.
-- Historical paystack_transactions rows with requested_channel = 'bank_transfer' stay valid (the check constraint is
-- unchanged), so old records and refunds keep working.

update payment_providers
   set settings = jsonb_set(
         settings, '{channels}',
         case when exists (select 1 from jsonb_array_elements_text(settings -> 'channels') c where c <> 'bank_transfer')
              then (select jsonb_agg(c) from jsonb_array_elements_text(settings -> 'channels') c where c <> 'bank_transfer')
              else '["card"]'::jsonb end),
       updated_at = now()
 where provider = 'paystack'
   and jsonb_typeof(settings -> 'channels') = 'array'
   and (settings -> 'channels') ? 'bank_transfer';

create or replace function public.payments_set_paystack_options(p_channels text[], p_currencies text[])
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin(); c text;
begin
  if p_channels is null or cardinality(p_channels) = 0 then raise exception 'Choose at least one payment channel.' using errcode = 'P0001'; end if;
  foreach c in array p_channels loop
    if c not in ('card', 'apple_pay') then raise exception 'Unsupported channel %.', c using errcode = 'P0001'; end if;
  end loop;
  if p_currencies is null or cardinality(p_currencies) = 0 then raise exception 'Choose at least one currency.' using errcode = 'P0001'; end if;
  foreach c in array p_currencies loop
    if c not in ('KES', 'USD', 'NGN', 'GHS', 'ZAR') then raise exception 'Paystack cannot collect %.', c using errcode = 'P0001'; end if;
  end loop;
  update payment_providers
     set settings = settings || jsonb_build_object('channels', to_jsonb(p_channels), 'currencies', to_jsonb(p_currencies)),
         updated_at = now()
   where user_id = uid and provider = 'paystack';
  if not found then raise exception 'Connect Paystack first.' using errcode = 'P0001'; end if;
  perform finance_audit(uid, 'configure', 'payment_provider', null, null,
    jsonb_build_object('provider', 'paystack', 'channels', p_channels, 'currencies', p_currencies));
end
$$;

revoke all on function public.payments_set_paystack_options(text[], text[]) from public, anon;
grant execute on function public.payments_set_paystack_options(text[], text[]) to authenticated;
